/**
 * Phase 23 delegation application service.
 *
 * Creation, revocation, listing, and use-time authorization for
 * agent-to-agent delegations. Authority rules (all server-side):
 *
 * - Delegated capabilities ⊆ closed DELEGABLE set (auth caps only).
 * - Delegated capabilities ⊆ delegator's live capabilities
 *   (union over active, unexpired credentials) — checked at
 *   creation AND at every use, so revoking A's credential
 *   fail-closes B's delegation without touching the record.
 * - Both agents must belong to the creating operator (no
 *   cross-operator delegation, ever).
 * - Agent creators may only delegate as themselves.
 *
 * This service is ADVISORY-adjacent: it authorizes API operations.
 * It never touches wallets, chain state, attestors, or enforcement
 * — those modules are not imported here.
 */
import { randomUUID } from "node:crypto";
import {
  DELEGATION_VERSION,
  authorizeDelegation,
  effectiveDelegationStatus,
  validateDelegationCapabilities,
  validateDelegationExpiry,
  validateDelegationScope,
} from "@bond/shared-types";
import type { PoolClient } from "pg";
import type { DelegationRole } from "../db/stores/delegations.js";
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import { getAgentService } from "./agents.js";
import { recordEvent } from "./events.js";
import { listAgentCredentials } from "../db/stores/agent-credentials.js";
import {
  findDelegationById,
  insertDelegation,
  listDelegationsForAgent,
  markExpiredDelegations,
  revokeDelegation,
} from "../db/stores/delegations.js";

function toApiError(error: unknown): ApiError {
  if (error instanceof Error && error.name === "DomainError") {
    const code = (error as { code?: string }).code ?? "INVALID_DELEGATION";
    return new ApiError(code, error.message);
  }
  throw error;
}

/**
 * Agent-level authority: union of capabilities across the agent's
 * active, unexpired credentials. Credentials are keys; authority
 * belongs to the agent.
 */
export async function delegatorCapabilities(
  agentId: string,
  client?: PoolClient,
): Promise<string[]> {
  const rows = await listAgentCredentials(agentId, client);
  const now = Date.now();
  const caps = new Set<string>();
  for (const row of rows) {
    if (row.status !== "ACTIVE") {
      continue;
    }
    if (row.expires_at !== null && Date.parse(String(row.expires_at)) <= now) {
      continue;
    }
    const list = Array.isArray(row.capabilities) ? row.capabilities : [];
    for (const cap of list) {
      if (typeof cap === "string") {
        caps.add(cap);
      }
    }
  }
  return [...caps];
}

export interface DelegationView {
  readonly delegationId: string;
  readonly delegatorAgentId: string;
  readonly delegateAgentId: string;
  readonly capabilities: readonly string[];
  readonly scope: {
    readonly actionTypes: readonly string[] | null;
    readonly tools: readonly string[] | null;
    readonly models: readonly string[] | null;
    readonly providers: readonly string[] | null;
  };
  readonly status: string;
  readonly version: number;
  readonly protocolVersion: typeof DELEGATION_VERSION;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

function toView(row: {
  readonly id: string;
  readonly delegator_agent_id: string;
  readonly delegate_agent_id: string;
  readonly capabilities: unknown;
  readonly scope: unknown;
  readonly status: string;
  readonly version: number;
  readonly created_by: string;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly revocation_reason: string | null;
}): DelegationView {
  const caps = Array.isArray(row.capabilities)
    ? (row.capabilities as unknown[]).filter(
        (c): c is string => typeof c === "string",
      )
    : [];
  const scope = (row.scope ?? {}) as Record<string, unknown>;
  const list = (key: string): readonly string[] | null => {
    const value = scope[key];
    if (value === null || value === undefined) {
      return null;
    }
    return Array.isArray(value)
      ? (value as unknown[]).filter((c): c is string => typeof c === "string")
      : null;
  };
  return {
    delegationId: row.id,
    delegatorAgentId: row.delegator_agent_id,
    delegateAgentId: row.delegate_agent_id,
    capabilities: caps,
    scope: {
      actionTypes: list("actionTypes"),
      tools: list("tools"),
      models: list("models"),
      providers: list("providers"),
    },
    status: effectiveDelegationStatus({
      status: row.status,
      expiresAt: String(row.expires_at),
      nowMs: Date.now(),
    }),
    version: row.version,
    protocolVersion: DELEGATION_VERSION,
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    revocationReason: row.revocation_reason,
    createdBy: row.created_by,
    createdAt: String(row.created_at),
  };
}

export async function createDelegationService(input: {
  readonly operatorId: string;
  /** Agent creator (when the call is agent-authenticated). */
  readonly creatorAgentId?: string;
  readonly delegatorAgentId: string;
  readonly delegateAgentId: string;
  readonly capabilities: unknown;
  readonly expiresAt: unknown;
  readonly scope?: unknown;
  readonly requestId?: string | null;
}): Promise<DelegationView> {
  if (
    input.creatorAgentId !== undefined &&
    input.creatorAgentId !== input.delegatorAgentId
  ) {
    throw new ApiError("FORBIDDEN", "Agents may only delegate as themselves");
  }
  // Ownership first: both agents must belong to the operator, so
  // cross-operator delegation fails before any other check.
  await getAgentService(input.delegatorAgentId, input.operatorId);
  await getAgentService(input.delegateAgentId, input.operatorId);
  if (input.delegatorAgentId === input.delegateAgentId) {
    throw new ApiError("INVALID_DELEGATION", "Cannot delegate to self");
  }
  let capabilities;
  let scope;
  let expiresAt: string;
  try {
    capabilities = validateDelegationCapabilities(input.capabilities);
    scope = validateDelegationScope(
      input.scope as
        | {
            readonly actionTypes?: readonly string[];
            readonly tools?: readonly string[];
            readonly models?: readonly string[];
            readonly providers?: readonly string[];
          }
        | undefined,
    );
    expiresAt = validateDelegationExpiry(input.expiresAt, Date.now());
  } catch (error) {
    throw toApiError(error);
  }
  // Pre-check possession BEFORE opening the insert transaction so a
  // denial can be audited durably (an in-tx audit would roll back
  // with the rejection). The insert tx rechecks (fail-closed on
  // races); use-time checks provide the final guarantee.
  const prePossessed = await delegatorCapabilities(input.delegatorAgentId);
  const preMissing = capabilities.filter((c) => !prePossessed.includes(c));
  if (preMissing.length > 0) {
    try {
      await recordEvent({
        type: "delegation.capability_denied",
        agentId: input.delegatorAgentId,
        actor:
          input.creatorAgentId !== undefined
            ? `agent:${input.creatorAgentId}`
            : `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: {
          delegateAgentId: input.delegateAgentId,
          missingCapabilities: preMissing,
        },
      });
    } catch {
      // Audit must never break authorization.
    }
    throw new ApiError(
      "DELEGATION_DENIED",
      "Delegator does not possess the requested capabilities",
    );
  }
  return withTransaction(async (client) => {
    // Possession is rechecked here (inside the insert tx) so a
    // credential revoked between the pre-check and the insert still
    // fail-closes; use-time checks provide the final guarantee.
    const possessed = await delegatorCapabilities(
      input.delegatorAgentId,
      client,
    );
    const missing = capabilities.filter((c) => !possessed.includes(c));
    if (missing.length > 0) {
      throw new ApiError(
        "DELEGATION_DENIED",
        "Delegator does not possess the requested capabilities",
      );
    }
    const id = `dlg_${randomUUID()}`;
    await insertDelegation(
      {
        id,
        delegatorAgentId: input.delegatorAgentId,
        delegateAgentId: input.delegateAgentId,
        capabilities,
        scope: {
          actionTypes: scope.actionTypes,
          tools: scope.tools,
          models: scope.models,
          providers: scope.providers,
        },
        expiresAt,
        createdBy:
          input.creatorAgentId !== undefined
            ? `agent:${input.creatorAgentId}`
            : `operator:${input.operatorId}`,
      },
      client,
    );
    await recordEvent(
      {
        type: "delegation.created",
        agentId: input.delegatorAgentId,
        actor:
          input.creatorAgentId !== undefined
            ? `agent:${input.creatorAgentId}`
            : `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: {
          delegationId: id,
          delegatorAgentId: input.delegatorAgentId,
          delegateAgentId: input.delegateAgentId,
          capabilities,
          protocolVersion: DELEGATION_VERSION,
        },
      },
      client,
    );
    const row = await findDelegationById(id, client);
    if (!row) {
      throw new ApiError("INTERNAL_ERROR", "Delegation was not created");
    }
    try {
      await markExpiredDelegations(100);
    } catch {
      // Hygiene must never break creation.
    }
    return toView(row);
  });
}

export async function revokeDelegationService(input: {
  readonly operatorId: string;
  readonly creatorAgentId?: string;
  readonly delegationId: string;
  readonly reason?: unknown;
  readonly requestId?: string | null;
}): Promise<DelegationView> {
  const reason =
    typeof input.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 256)
      : null;
  return withTransaction(async (client) => {
    const existing = await findDelegationById(input.delegationId, client);
    if (!existing) {
      throw new ApiError("NOT_FOUND", "Delegation not found");
    }
    // Revocation authority: the delegator's operator, or the
    // delegator agent itself. Delegates cannot revoke (they can
    // simply stop using it); foreign operators fail on ownership.
    if (input.creatorAgentId !== undefined) {
      if (input.creatorAgentId !== existing.delegator_agent_id) {
        throw new ApiError(
          "FORBIDDEN",
          "Only the delegator may revoke its delegations",
        );
      }
    } else {
      await getAgentService(existing.delegator_agent_id, input.operatorId);
    }
    if (existing.status === "revoked") {
      return toView(existing);
    }
    const revoked = await revokeDelegation(input.delegationId, reason, client);
    if (!revoked) {
      throw new ApiError("NOT_FOUND", "Delegation not found");
    }
    await recordEvent(
      {
        type: "delegation.revoked",
        agentId: existing.delegator_agent_id,
        actor:
          input.creatorAgentId !== undefined
            ? `agent:${input.creatorAgentId}`
            : `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: {
          delegationId: existing.id,
          delegateAgentId: existing.delegate_agent_id,
          reason,
        },
      },
      client,
    );
    return toView(revoked);
  });
}

export async function getDelegationService(input: {
  readonly operatorId: string;
  readonly creatorAgentId?: string;
  readonly delegationId: string;
}): Promise<DelegationView> {
  const row = await findDelegationById(input.delegationId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Delegation not found");
  }
  if (input.creatorAgentId !== undefined) {
    if (
      input.creatorAgentId !== row.delegator_agent_id &&
      input.creatorAgentId !== row.delegate_agent_id
    ) {
      throw new ApiError("FORBIDDEN", "Not your delegation");
    }
    return toView(row);
  }
  // Operator must own at least one side; ambiguous which, so check
  // delegator first, then delegate — missing both is 404-shaped to
  // avoid confirming foreign delegation existence... in practice
  // ownership failure surfaces as NOT_FOUND/FORBIDDEN from the
  // registry either way.
  try {
    await getAgentService(row.delegator_agent_id, input.operatorId);
  } catch {
    await getAgentService(row.delegate_agent_id, input.operatorId);
  }
  return toView(row);
}

export async function listDelegationsService(input: {
  readonly operatorId: string;
  readonly creatorAgentId?: string;
  readonly agentId: string;
  readonly role: DelegationRole;
  readonly liveOnly: boolean;
  readonly limit: number;
}): Promise<DelegationView[]> {
  if (
    input.creatorAgentId !== undefined &&
    input.creatorAgentId !== input.agentId
  ) {
    throw new ApiError("FORBIDDEN", "Not your delegations");
  }
  await getAgentService(input.agentId, input.operatorId);
  const rows = await listDelegationsForAgent(
    input.agentId,
    input.role,
    input.liveOnly,
    input.limit,
  );
  return rows.map(toView);
}

export interface AuthorizedDelegation {
  readonly delegationId: string;
  readonly delegatorAgentId: string;
  readonly delegateAgentId: string;
}

/**
 * Use-time authorization for delegated operations. All checks are
 * server-side against live state: delegate identity, revocation,
 * expiry, capability membership, the delegator's CURRENT
 * capabilities, and operation scope. Failures audit
 * `delegation.authorization_failed` with a reason code and surface
 * a generic 403 that reveals nothing about other agents'
 * delegations.
 */
export async function authorizeDelegatedUse(
  input: {
    readonly delegateAgentId: string;
    readonly delegationId: string;
    readonly requiredCapability: string;
    readonly operation?: {
      readonly actionType?: string | null;
      readonly tool?: string | null;
      readonly model?: string | null;
      readonly provider?: string | null;
    } | null;
    readonly requestId?: string | null;
  },
  client?: PoolClient,
): Promise<AuthorizedDelegation> {
  const row = await findDelegationById(input.delegationId, client);
  const deny = async (reason: string): Promise<never> => {
    try {
      await recordEvent(
        {
          type: "delegation.authorization_failed",
          agentId: input.delegateAgentId,
          actor: `agent:${input.delegateAgentId}`,
          requestId: input.requestId,
          payload: { delegationId: input.delegationId, reason },
        },
        client,
      );
    } catch {
      // Audit must never break authorization.
    }
    throw new ApiError("DELEGATION_DENIED", "Delegation not authorized");
  };
  if (!row) {
    await deny("unknown-delegation");
  }
  const delegation = row as NonNullable<typeof row>;
  const scope = (delegation.scope ?? {}) as Record<string, unknown>;
  const asList = (key: string): readonly string[] | null => {
    const value = scope[key];
    if (!Array.isArray(value)) {
      return null;
    }
    return (value as unknown[]).filter(
      (c): c is string => typeof c === "string",
    );
  };
  const possessed = await delegatorCapabilities(
    delegation.delegator_agent_id,
    client,
  );
  const verdict = authorizeDelegation({
    delegateAgentId: input.delegateAgentId,
    requiredCapability: input.requiredCapability,
    delegation: {
      delegateAgentId: delegation.delegate_agent_id,
      status: delegation.status,
      expiresAt: String(delegation.expires_at),
      capabilities: Array.isArray(delegation.capabilities)
        ? (delegation.capabilities as unknown[]).filter(
            (c): c is string => typeof c === "string",
          )
        : [],
      scope: {
        actionTypes: asList("actionTypes"),
        tools: asList("tools"),
        models: asList("models"),
        providers: asList("providers"),
      },
    },
    delegatorCapabilities: possessed,
    operation: input.operation ?? null,
    nowMs: Date.now(),
  });
  if (!verdict.ok) {
    await deny(verdict.reason);
  }
  return {
    delegationId: delegation.id,
    delegatorAgentId: delegation.delegator_agent_id,
    delegateAgentId: delegation.delegate_agent_id,
  };
}
