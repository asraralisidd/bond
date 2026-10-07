/**
 * Agent credential store. Raw secrets are NEVER stored — only
 * SHA-256(secret_hash), exactly like attestor_credentials.
 * Verification uses constant-time comparison against the stored hash.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export type AgentCredentialStatus = "ACTIVE" | "REVOKED";

export interface AgentCredentialRow {
  readonly credential_id: string;
  readonly agent_id: string;
  readonly secret_hash: string;
  readonly status: string;
  readonly capabilities: unknown;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function hashCredentialSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newCredentialId(): string {
  return `cred_${randomBytes(12).toString("hex")}`;
}

export function newCredentialSecret(): string {
  return randomBytes(32).toString("hex");
}

export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function insertAgentCredential(
  input: {
    readonly credentialId: string;
    readonly agentId: string;
    readonly secretHash: string;
    readonly capabilities: readonly string[];
    readonly expiresAt: string | null;
  },
  client?: PoolClient,
): Promise<AgentCredentialRow> {
  const result = await query<AgentCredentialRow>(
    `INSERT INTO agent_credentials
       (credential_id, agent_id, secret_hash, status, capabilities, expires_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5)
     RETURNING credential_id, agent_id, secret_hash, status,
       capabilities, expires_at, last_used_at, revoked_at,
       revocation_reason, created_at, updated_at`,
    [
      input.credentialId,
      input.agentId,
      input.secretHash,
      JSON.stringify(input.capabilities),
      input.expiresAt,
    ],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insertAgentCredential returned no row");
  }
  return row;
}

export async function findAgentCredentialById(
  credentialId: string,
  client?: PoolClient,
): Promise<AgentCredentialRow | null> {
  const result = await query<AgentCredentialRow>(
    `SELECT credential_id, agent_id, secret_hash, status,
       capabilities, expires_at, last_used_at, revoked_at,
       revocation_reason, created_at, updated_at
     FROM agent_credentials WHERE credential_id = $1`,
    [credentialId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function listAgentCredentials(
  agentId: string,
  client?: PoolClient,
): Promise<AgentCredentialRow[]> {
  const result = await query<AgentCredentialRow>(
    `SELECT credential_id, agent_id, secret_hash, status,
       capabilities, expires_at, last_used_at, revoked_at,
       revocation_reason, created_at, updated_at
     FROM agent_credentials WHERE agent_id = $1
     ORDER BY created_at ASC`,
    [agentId],
    client,
  );
  return result.rows;
}

export async function revokeAgentCredential(
  credentialId: string,
  reason: string | null,
  client?: PoolClient,
): Promise<AgentCredentialRow | null> {
  const result = await query<AgentCredentialRow>(
    `UPDATE agent_credentials
     SET status = 'REVOKED', revoked_at = now(),
       revocation_reason = $2, updated_at = now()
     WHERE credential_id = $1 AND status = 'ACTIVE'
     RETURNING credential_id, agent_id, secret_hash, status,
       capabilities, expires_at, last_used_at, revoked_at,
       revocation_reason, created_at, updated_at`,
    [credentialId, reason],
    client,
  );
  return result.rows[0] ?? null;
}

export async function touchAgentCredential(
  credentialId: string,
  client?: PoolClient,
): Promise<void> {
  await query(
    `UPDATE agent_credentials
     SET last_used_at = now(), updated_at = now()
     WHERE credential_id = $1`,
    [credentialId],
    client,
  );
}
