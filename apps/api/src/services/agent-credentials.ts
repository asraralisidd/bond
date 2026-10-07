/**
 * Agent credential lifecycle (Phase 18, OFF-CHAIN only).
 *
 * Operator-managed: create/list/rotate/revoke. Raw secrets exist only
 * in create/rotate responses — never stored, logged, or emitted in
 * events. Rotation is atomic (new credential + old revocation in one
 * transaction) so there is no window where both or neither work.
 */
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import {
  findAgentCredentialById,
  hashCredentialSecret,
  insertAgentCredential,
  listAgentCredentials,
  newCredentialId,
  newCredentialSecret,
  countActiveAgentCredentials,
  revokeAgentCredential,
} from "../db/stores/agent-credentials.js";
import { recordEvent } from "./events.js";
import { getAgentService } from "./agents.js";

/** Initial Phase 18 capability allowlist. Unknown values are denied. */
export const AGENT_CAPABILITIES = [
  "activity:submit",
  "agent:read",
  "risk:read",
  "verification:read",
  "reputation:read",
] as const;

/**
 * Credential lifecycle policy (Phase 19).
 *
 * - At most MAX_ACTIVE_CREDENTIALS_PER_AGENT live credentials per
 *   agent: bounds spray/abuse surface while leaving room for rotation
 *   overlap and a few integrations. Rotation itself is exempt in
 *   effect (it revokes the old credential in the same transaction,
 *   keeping the net count flat).
 * - New credentials default to a 90-day lifetime; explicit expiries
 *   beyond one year are rejected. Pre-policy credentials with NULL
 *   expiry keep authenticating (no mass-expiry, no migration).
 */
export const MAX_ACTIVE_CREDENTIALS_PER_AGENT = 5;
export const CREDENTIAL_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CREDENTIAL_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

function parseCapabilities(value: unknown): string[] {
  if (value === undefined) {
    return [...AGENT_CAPABILITIES];
  }
  if (!Array.isArray(value)) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid capabilities");
  }
  const allowed = new Set<string>(AGENT_CAPABILITIES);
  const capabilities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new ApiError("INVALID_IDENTIFIER", "Unknown capability");
    }
    if (!capabilities.includes(entry)) {
      capabilities.push(entry);
    }
  }
  if (capabilities.length === 0) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid capabilities");
  }
  return capabilities;
}

function parseExpiry(value: unknown): string | null {
  if (value === undefined || value === null) {
    // New credentials default to a bounded lifetime rather than living
    // forever. Existing credentials with NULL expiry keep working —
    // this default applies to issuance only, never retroactively.
    return new Date(Date.now() + CREDENTIAL_DEFAULT_TTL_MS).toISOString();
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid expiresAt");
  }
  if (Date.parse(value) <= Date.now()) {
    throw new ApiError("INVALID_IDENTIFIER", "expiresAt must be in the future");
  }
  if (Date.parse(value) - Date.now() > CREDENTIAL_MAX_TTL_MS) {
    throw new ApiError(
      "INVALID_IDENTIFIER",
      "expiresAt exceeds maximum credential lifetime",
    );
  }
  return value;
}

export interface AgentCredentialMetadata {
  readonly credentialId: string;
  readonly agentId: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
}

function toMetadata(row: {
  credential_id: string;
  agent_id: string;
  status: string;
  capabilities: unknown;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}): AgentCredentialMetadata {
  return {
    credentialId: row.credential_id,
    agentId: row.agent_id,
    status: row.status,
    capabilities: Array.isArray(row.capabilities)
      ? (row.capabilities as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    createdAt: row.created_at,
  };
}

export async function createAgentCredentialService(input: {
  operatorId: string;
  agentId: string;
  capabilities?: unknown;
  expiresAt?: unknown;
  requestId?: string | null;
}): Promise<{ metadata: AgentCredentialMetadata; secret: string }> {
  await getAgentService(input.agentId, input.operatorId);
  const active = await countActiveAgentCredentials(input.agentId);
  if (active >= MAX_ACTIVE_CREDENTIALS_PER_AGENT) {
    try {
      await recordEvent({
        type: "credential.policy_denied",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: {
          policy: "max_active_credentials",
          active,
          max: MAX_ACTIVE_CREDENTIALS_PER_AGENT,
        },
      });
    } catch {
      // Audit must never break authorization.
    }
    throw new ApiError("INVALID_IDENTIFIER", "Agent credential limit reached");
  }
  const capabilities = parseCapabilities(input.capabilities);
  if (
    typeof input.expiresAt === "string" &&
    !Number.isNaN(Date.parse(input.expiresAt)) &&
    Date.parse(input.expiresAt) - Date.now() > CREDENTIAL_MAX_TTL_MS
  ) {
    try {
      await recordEvent({
        type: "credential.policy_denied",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { policy: "max_expiry" },
      });
    } catch {
      // Audit must never break authorization.
    }
  }
  const expiresAt = parseExpiry(input.expiresAt);
  const credentialId = newCredentialId();
  const secret = newCredentialSecret();
  const row = await withTransaction(async (client) => {
    const created = await insertAgentCredential(
      {
        credentialId,
        agentId: input.agentId,
        secretHash: hashCredentialSecret(secret),
        capabilities,
        expiresAt,
      },
      client,
    );
    await recordEvent(
      {
        type: "credential.created",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { credentialId, capabilities },
      },
      client,
    );
    return created;
  });
  return { metadata: toMetadata(row), secret };
}

export async function listAgentCredentialsService(input: {
  operatorId: string;
  agentId: string;
}): Promise<AgentCredentialMetadata[]> {
  await getAgentService(input.agentId, input.operatorId);
  const rows = await listAgentCredentials(input.agentId);
  return rows.map(toMetadata);
}

export async function rotateAgentCredentialService(input: {
  operatorId: string;
  agentId: string;
  credentialId: string;
  requestId?: string | null;
}): Promise<{ metadata: AgentCredentialMetadata; secret: string }> {
  await getAgentService(input.agentId, input.operatorId);
  const existing = await findAgentCredentialById(input.credentialId);
  if (!existing || existing.agent_id !== input.agentId) {
    throw new ApiError("NOT_FOUND", "Credential not found");
  }
  if (existing.status !== "ACTIVE") {
    throw new ApiError("INVALID_IDENTIFIER", "Credential is not active");
  }
  const capabilities = Array.isArray(existing.capabilities)
    ? (existing.capabilities as unknown[]).filter(
        (c): c is string => typeof c === "string",
      )
    : [];
  const credentialId = newCredentialId();
  const secret = newCredentialSecret();
  const row = await withTransaction(async (client) => {
    const created = await insertAgentCredential(
      {
        credentialId,
        agentId: input.agentId,
        secretHash: hashCredentialSecret(secret),
        capabilities,
        expiresAt: existing.expires_at,
      },
      client,
    );
    await revokeAgentCredential(input.credentialId, "rotated", client);
    await recordEvent(
      {
        type: "credential.rotated",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: {
          credentialId,
          rotatedFrom: input.credentialId,
          capabilities,
        },
      },
      client,
    );
    return created;
  });
  return { metadata: toMetadata(row), secret };
}

export async function revokeAgentCredentialService(input: {
  operatorId: string;
  agentId: string;
  credentialId: string;
  reason?: unknown;
  requestId?: string | null;
}): Promise<AgentCredentialMetadata> {
  await getAgentService(input.agentId, input.operatorId);
  const existing = await findAgentCredentialById(input.credentialId);
  if (!existing || existing.agent_id !== input.agentId) {
    throw new ApiError("NOT_FOUND", "Credential not found");
  }
  const reason =
    typeof input.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 256)
      : null;
  const row = await withTransaction(async (client) => {
    const revoked = await revokeAgentCredential(
      input.credentialId,
      reason,
      client,
    );
    if (!revoked) {
      throw new ApiError("INVALID_IDENTIFIER", "Credential is not active");
    }
    await recordEvent(
      {
        type: "credential.revoked",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { credentialId: input.credentialId, reason },
      },
      client,
    );
    return revoked;
  });
  return toMetadata(row);
}
