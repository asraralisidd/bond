/**
 * Operator + session store. Sessions store only token hashes;
 * raw tokens never touch the database.
 */
import { createHash, randomBytes } from "node:crypto";
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface OperatorRow {
  readonly id: string;
  readonly external_key: string;
  readonly wallet_address: string | null;
  readonly wallet_network: string | null;
}

export interface SessionRow {
  readonly id: string;
  readonly operator_id: string;
  readonly expires_at: string;
  readonly revoked: boolean;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newToken(prefix: string): { id: string; token: string } {
  const id = `${prefix}_${randomBytes(12).toString("hex")}`;
  return { id, token: `${id}.${randomBytes(32).toString("hex")}` };
}

export async function createOperator(
  id: string,
  externalKey: string,
  client?: PoolClient,
): Promise<OperatorRow> {
  const result = await query<OperatorRow>(
    `INSERT INTO operators (id, external_key)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET external_key = EXCLUDED.external_key
     RETURNING id, external_key, wallet_address, wallet_network`,
    [id, externalKey],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createOperator returned no row");
  }
  return row;
}

export async function createSession(
  id: string,
  operatorId: string,
  tokenHash: string,
  expiresAt: string,
  client?: PoolClient,
): Promise<SessionRow> {
  const result = await query<SessionRow>(
    `INSERT INTO sessions (id, operator_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, operator_id,
       to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
       revoked`,
    [id, operatorId, tokenHash, expiresAt],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createSession returned no row");
  }
  return row;
}

export async function findSessionByTokenHash(
  tokenHash: string,
  client?: PoolClient,
): Promise<SessionRow | null> {
  const result = await query<SessionRow>(
    `SELECT id, operator_id,
       to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
       revoked
     FROM sessions WHERE token_hash = $1`,
    [tokenHash],
    client,
  );
  return result.rows[0] ?? null;
}

export async function revokeSession(
  id: string,
  client?: PoolClient,
): Promise<void> {
  await query("UPDATE sessions SET revoked = TRUE WHERE id = $1", [id], client);
}
