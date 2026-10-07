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
] as const;

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
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid expiresAt");
  }
  if (Date.parse(value) <= Date.now()) {
    throw new ApiError("INVALID_IDENTIFIER", "expiresAt must be in the future");
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
  const capabilities = parseCapabilities(input.capabilities);
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
