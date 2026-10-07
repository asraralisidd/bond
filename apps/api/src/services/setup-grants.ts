/**
 * Operator-delegated setup grants (Phase 19, OFF-CHAIN only).
 *
 * A grant authorizes exactly ONE setup operation (agent registration,
 * bond init, or attestation init) for the issuing operator. Raw secrets
 * exist only in the create response — never stored, logged, or emitted
 * in events. Consumption is atomic (conditional UPDATE): concurrent
 * consumers race and exactly one wins.
 *
 * A grant is not a session, not a credential, and confers no other
 * authority. It cannot chain, escalate, or persist.
 */
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import {
  consumeSetupGrant,
  findSetupGrantById,
  hashGrantSecret,
  insertSetupGrant,
  listSetupGrantsByOperator,
  newGrantId,
  newGrantSecret,
  revokeSetupGrant,
  secretsEqual,
} from "../db/stores/setup-grants.js";
import type { SetupGrantRow } from "../db/stores/setup-grants.js";
import { findAgentById } from "../db/stores/registry.js";
import { recordEvent } from "./events.js";
import { getAgentService } from "./agents.js";

/** Setup operations a grant may authorize. Nothing else, ever. */
export const SETUP_GRANT_SCOPES = [
  "agent:register",
  "bond:init",
  "attestation:init",
] as const;

export type SetupGrantScope = (typeof SETUP_GRANT_SCOPES)[number];

/** Default grant lifetime: 15 minutes. Maximum: 60 minutes. */
export const SETUP_GRANT_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const SETUP_GRANT_MAX_TTL_MS = 60 * 60 * 1000;

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid scopes");
  }
  const allowed = new Set<string>(SETUP_GRANT_SCOPES);
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new ApiError("INVALID_IDENTIFIER", "Unknown setup scope");
    }
    if (!scopes.includes(entry)) {
      scopes.push(entry);
    }
  }
  return scopes;
}

function parseGrantExpiry(value: unknown, now: number): string {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new ApiError("INVALID_IDENTIFIER", "Invalid expiresAt");
    }
    const at = Date.parse(value);
    if (at <= now) {
      throw new ApiError(
        "INVALID_IDENTIFIER",
        "expiresAt must be in the future",
      );
    }
    if (at - now > SETUP_GRANT_MAX_TTL_MS) {
      throw new ApiError(
        "INVALID_IDENTIFIER",
        "expiresAt exceeds maximum grant lifetime",
      );
    }
    return value;
  }
  return new Date(now + SETUP_GRANT_DEFAULT_TTL_MS).toISOString();
}

export interface SetupGrantMetadata {
  readonly grantId: string;
  readonly operatorId: string;
  readonly agentId: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
}

function toMetadata(row: SetupGrantRow): SetupGrantMetadata {
  return {
    grantId: row.grant_id,
    operatorId: row.operator_id,
    agentId: row.agent_id,
    scopes: Array.isArray(row.scopes)
      ? (row.scopes as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    createdAt: row.created_at,
  };
}

export async function createSetupGrantService(input: {
  operatorId: string;
  agentId?: unknown;
  scopes: unknown;
  expiresAt?: unknown;
  requestId?: string | null;
}): Promise<{ metadata: SetupGrantMetadata; secret: string }> {
  const scopes = parseScopes(input.scopes);
  const now = Date.now();
  const expiresAt = parseGrantExpiry(input.expiresAt, now);
  let agentId: string | null = null;
  if (input.agentId !== undefined && input.agentId !== null) {
    if (typeof input.agentId !== "string" || input.agentId.length === 0) {
      throw new ApiError("INVALID_IDENTIFIER", "Invalid agentId");
    }
    // Bound agent must already belong to the issuing operator.
    await getAgentService(input.agentId, input.operatorId);
    agentId = input.agentId;
  }
  // Binding policy: bond:init and attestation:init operate on an
  // existing agent, so those scopes require an (owned) agent binding.
  // agent:register creates the agent, so it must be unbound.
  const needsBinding =
    scopes.includes("bond:init") || scopes.includes("attestation:init");
  if (needsBinding && agentId === null) {
    throw new ApiError(
      "INVALID_IDENTIFIER",
      "bond:init and attestation:init grants require agent binding",
    );
  }
  if (!needsBinding && agentId !== null) {
    throw new ApiError(
      "INVALID_IDENTIFIER",
      "agent:register grants must not bind an agent",
    );
  }
  // Verify the bound agent still exists at consume time, not just here.
  const grantId = newGrantId();
  const secret = newGrantSecret();
  const row = await withTransaction(async (client) => {
    const created = await insertSetupGrant(
      {
        grantId,
        secretHash: hashGrantSecret(secret),
        operatorId: input.operatorId,
        agentId,
        scopes,
        expiresAt,
      },
      client,
    );
    await recordEvent(
      {
        type: "setup_grant.created",
        agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { grantId, scopes },
      },
      client,
    );
    return created;
  });
  return { metadata: toMetadata(row), secret };
}

export interface ConsumedGrant {
  readonly grantId: string;
  readonly operatorId: string;
  readonly agentId: string | null;
  readonly scopes: readonly string[];
}

/**
 * Verify a presented grant secret and atomically consume the grant.
 * Returns the grant context on exactly-once success; throws generic
 * 401 otherwise (no existence/revocation/expiry distinction).
 */
export async function consumeSetupGrantService(input: {
  grantId: string;
  secret: string;
  requestId?: string | null;
}): Promise<ConsumedGrant> {
  const fail = async (agentId: string | null): Promise<never> => {
    try {
      await recordEvent({
        type: "setup_grant.authentication_failed",
        agentId,
        actor: `grant:${input.grantId}`,
        requestId: input.requestId,
        payload: { grantId: input.grantId },
      });
    } catch {
      // Audit must never break authentication.
    }
    throw new ApiError("UNAUTHORIZED", "Invalid or expired grant");
  };
  const found = await findSetupGrantById(input.grantId);
  if (
    !found ||
    !secretsEqual(hashGrantSecret(input.secret), found.secret_hash)
  ) {
    await fail(found?.agent_id ?? null);
  }
  const consumed = await consumeSetupGrant(input.grantId);
  if (!consumed) {
    // Lost the race, already consumed, revoked, or expired.
    await fail(found?.agent_id ?? null);
  }
  const grant = consumed as NonNullable<typeof consumed>;
  try {
    await recordEvent({
      type: "setup_grant.consumed",
      agentId: grant.agent_id,
      actor: `operator:${grant.operator_id}`,
      requestId: input.requestId,
      payload: { grantId: grant.grant_id },
    });
  } catch {
    // Audit must never break authorization.
  }
  return {
    grantId: grant.grant_id,
    operatorId: grant.operator_id,
    agentId: grant.agent_id,
    scopes: Array.isArray(grant.scopes)
      ? (grant.scopes as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
  };
}

export async function listSetupGrantsService(input: {
  operatorId: string;
}): Promise<SetupGrantMetadata[]> {
  const rows = await listSetupGrantsByOperator(input.operatorId);
  return rows.map(toMetadata);
}

export async function revokeSetupGrantService(input: {
  operatorId: string;
  grantId: string;
  reason?: unknown;
  requestId?: string | null;
}): Promise<SetupGrantMetadata> {
  const existing = await findSetupGrantById(input.grantId);
  if (!existing || existing.operator_id !== input.operatorId) {
    throw new ApiError("NOT_FOUND", "Grant not found");
  }
  const reason =
    typeof input.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 256)
      : null;
  const row = await withTransaction(async (client) => {
    const revoked = await revokeSetupGrant(input.grantId, reason, client);
    if (!revoked) {
      throw new ApiError(
        "INVALID_IDENTIFIER",
        "Grant is already consumed or revoked",
      );
    }
    await recordEvent(
      {
        type: "setup_grant.revoked",
        agentId: revoked.agent_id,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { grantId: input.grantId, reason },
      },
      client,
    );
    return revoked;
  });
  return toMetadata(row);
}

/** Confirm a bound agent still exists and belongs to the operator. */
export async function requireGrantAgent(
  grant: ConsumedGrant,
): Promise<string | null> {
  if (grant.agentId === null) {
    return null;
  }
  const agent = await findAgentById(grant.agentId);
  if (!agent || agent.operator_id !== grant.operatorId) {
    throw new ApiError("FORBIDDEN", "Grant agent binding invalid");
  }
  return agent.id;
}
