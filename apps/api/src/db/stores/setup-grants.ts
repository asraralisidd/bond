/**
 * Setup grant store. Raw secrets are NEVER stored — only
 * SHA-256(secret_hash). Single-use consumption is enforced by a
 * conditional UPDATE (consumed_at IS NULL AND revoked_at IS NULL AND
 * not expired): concurrent consumers race on the row and exactly one
 * wins; losers get zero rows back.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface SetupGrantRow {
  readonly grant_id: string;
  readonly secret_hash: string;
  readonly operator_id: string;
  readonly agent_id: string | null;
  readonly scopes: unknown;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function hashGrantSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newGrantId(): string {
  return `grant_${randomBytes(12).toString("hex")}`;
}

export function newGrantSecret(): string {
  return randomBytes(32).toString("hex");
}

export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const GRANT_COLUMNS = `grant_id, operator_id, agent_id, secret_hash, scopes,
  expires_at, consumed_at, revoked_at, revocation_reason,
  created_at, updated_at`;

export async function insertSetupGrant(
  input: {
    readonly grantId: string;
    readonly secretHash: string;
    readonly operatorId: string;
    readonly agentId: string | null;
    readonly scopes: readonly string[];
    readonly expiresAt: string;
  },
  client?: PoolClient,
): Promise<SetupGrantRow> {
  const result = await query<SetupGrantRow>(
    `INSERT INTO setup_grants
       (grant_id, secret_hash, operator_id, agent_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${GRANT_COLUMNS}`,
    [
      input.grantId,
      input.secretHash,
      input.operatorId,
      input.agentId,
      JSON.stringify(input.scopes),
      input.expiresAt,
    ],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insertSetupGrant returned no row");
  }
  return row;
}

export async function findSetupGrantById(
  grantId: string,
  client?: PoolClient,
): Promise<SetupGrantRow | null> {
  const result = await query<SetupGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM setup_grants WHERE grant_id = $1`,
    [grantId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function listSetupGrantsByOperator(
  operatorId: string,
  client?: PoolClient,
): Promise<SetupGrantRow[]> {
  const result = await query<SetupGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM setup_grants
     WHERE operator_id = $1
     ORDER BY created_at ASC`,
    [operatorId],
    client,
  );
  return result.rows;
}

/**
 * Atomically consume a grant. Returns the row only when this caller won
 * the race: active, unrevoked, unexpired, and previously unconsumed.
 * Losers (and invalid grants) get null — no check-then-update window.
 */
export async function consumeSetupGrant(
  grantId: string,
  client?: PoolClient,
): Promise<SetupGrantRow | null> {
  const result = await query<SetupGrantRow>(
    `UPDATE setup_grants
     SET consumed_at = now(), updated_at = now()
     WHERE grant_id = $1
       AND consumed_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
     RETURNING ${GRANT_COLUMNS}`,
    [grantId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function revokeSetupGrant(
  grantId: string,
  reason: string | null,
  client?: PoolClient,
): Promise<SetupGrantRow | null> {
  const result = await query<SetupGrantRow>(
    `UPDATE setup_grants
     SET revoked_at = now(), revocation_reason = $2, updated_at = now()
     WHERE grant_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
     RETURNING ${GRANT_COLUMNS}`,
    [grantId, reason],
    client,
  );
  return result.rows[0] ?? null;
}
