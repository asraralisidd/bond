/**
 * Phase 23 delegation stores.
 *
 * Records are never physically deleted: revocation flips status
 * (idempotent), expiry is evaluated dynamically with opportunistic
 * materialization for query hygiene. No secrets live here — only
 * agent ids, capability names, scope bounds, and timestamps.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface DelegationRow {
  readonly id: string;
  readonly delegator_agent_id: string;
  readonly delegate_agent_id: string;
  readonly capabilities: string[];
  readonly scope: {
    readonly actionTypes?: string[] | null;
    readonly tools?: string[] | null;
    readonly models?: string[] | null;
    readonly providers?: string[] | null;
  };
  readonly status: string;
  readonly version: number;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
}

const DELEGATION_COLUMNS = `id, delegator_agent_id, delegate_agent_id,
  capabilities, scope, status, version, created_by, created_at,
  updated_at, expires_at, revoked_at, revocation_reason`;

export async function insertDelegation(
  input: {
    readonly id: string;
    readonly delegatorAgentId: string;
    readonly delegateAgentId: string;
    readonly capabilities: readonly string[];
    readonly scope: {
      readonly actionTypes: readonly string[] | null;
      readonly tools: readonly string[] | null;
      readonly models: readonly string[] | null;
      readonly providers: readonly string[] | null;
    };
    readonly expiresAt: string;
    readonly createdBy: string;
  },
  client: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO delegations
       (id, delegator_agent_id, delegate_agent_id, capabilities,
        scope, status, version, created_by, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7)`,
    [
      input.id,
      input.delegatorAgentId,
      input.delegateAgentId,
      JSON.stringify(input.capabilities),
      JSON.stringify(input.scope),
      input.createdBy,
      input.expiresAt,
    ],
    client,
  );
}

export async function findDelegationById(
  id: string,
  client?: PoolClient,
): Promise<DelegationRow | null> {
  const result = await query<DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export type DelegationRole = "delegator" | "delegate" | "all";

/**
 * Agent-scoped listing, newest first, bounded. Liveness is
 * evaluated dynamically (status + expires_at) so readers never
 * depend on materialization having run.
 */
export async function listDelegationsForAgent(
  agentId: string,
  role: DelegationRole,
  liveOnly: boolean,
  limit: number,
  client?: PoolClient,
): Promise<DelegationRow[]> {
  const clauses: string[] = [];
  const values: unknown[] = [agentId];
  if (role === "delegator") {
    clauses.push("delegator_agent_id = $1");
  } else if (role === "delegate") {
    clauses.push("delegate_agent_id = $1");
  } else {
    clauses.push("(delegator_agent_id = $1 OR delegate_agent_id = $1)");
  }
  if (liveOnly) {
    clauses.push("status = 'active'");
    clauses.push("expires_at > now()");
  }
  values.push(limit);
  const result = await query<DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC LIMIT $2`,
    values,
    client,
  );
  return result.rows;
}

/**
 * Durable, idempotent revocation: already-revoked rows report back
 * unchanged (version untouched); active rows flip exactly once and
 * bump the lifecycle version for audit.
 */
export async function revokeDelegation(
  id: string,
  reason: string | null,
  client: PoolClient,
): Promise<DelegationRow | null> {
  const result = await query<DelegationRow>(
    `UPDATE delegations
      SET status = 'revoked', revoked_at = now(),
        revocation_reason = COALESCE($2, revocation_reason),
        version = version + 1, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING ${DELEGATION_COLUMNS}`,
    [id, reason],
    client,
  );
  if (result.rows[0]) {
    return result.rows[0];
  }
  return findDelegationById(id, client);
}

/** Opportunistic expiry materialization (bounded, best-effort). */
export async function markExpiredDelegations(limit: number): Promise<number> {
  const result = await query(
    `UPDATE delegations SET status = 'expired', updated_at = now()
      WHERE id IN (
        SELECT id FROM delegations
        WHERE status = 'active' AND expires_at <= now()
        LIMIT $1
      )`,
    [limit],
  );
  return result.rowCount ?? 0;
}
