/**
 * Protocol event store. Append-only is enforced by a database trigger;
 * this module exposes insert + read only (no update/delete functions).
 * Payloads must already be privacy-scrubbed by callers.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface ProtocolEventRow {
  readonly id: string;
  readonly type: string;
  readonly agent_id: string | null;
  readonly bond_id: string | null;
  readonly tx_id: string | null;
  readonly actor: string;
  readonly policy_version: string | null;
  readonly request_id: string | null;
  readonly payload: unknown;
  readonly created_at: string;
}

export interface InsertProtocolEvent {
  readonly id: string;
  readonly type: string;
  readonly agentId?: string | null;
  readonly bondId?: string | null;
  readonly txId?: string | null;
  readonly actor: string;
  readonly policyVersion?: string | null;
  readonly requestId?: string | null;
  readonly payload?: unknown;
}

export async function insertProtocolEvent(
  event: InsertProtocolEvent,
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO protocol_events
       (id, type, agent_id, bond_id, tx_id, actor, policy_version, request_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.id,
      event.type,
      event.agentId ?? null,
      event.bondId ?? null,
      event.txId ?? null,
      event.actor,
      event.policyVersion ?? null,
      event.requestId ?? null,
      JSON.stringify(event.payload ?? {}),
    ],
    client,
  );
}

export async function listProtocolEventsByAgent(
  agentId: string,
  limit: number,
  client?: PoolClient,
): Promise<ProtocolEventRow[]> {
  const result = await query<ProtocolEventRow>(
    `SELECT id, type, agent_id, bond_id, tx_id, actor, policy_version,
       request_id, payload,
       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
     FROM protocol_events
     WHERE agent_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [agentId, limit],
    client,
  );
  return result.rows;
}

export interface EventPageRow extends ProtocolEventRow {
  /** Full-precision epoch seconds for cursor positioning. */
  readonly created_epoch: string;
}

export interface EventPageScope {
  /** Single-agent scope (agent principal). */
  readonly agentId?: string;
  /** Operator scope: only events for agents this operator owns. */
  readonly operatorId?: string;
}

/**
 * Keyset page over protocol_events. Ordering is (created_at, id) —
 * total and deterministic. Callers pass limit+1 and treat an extra
 * row as the has-more signal. No OFFSET, ever.
 */
export async function listProtocolEventsPage(
  scope: EventPageScope,
  after: { createdEpoch: string; id: string } | null,
  type: string | null,
  limitPlusOne: number,
  client?: PoolClient,
): Promise<EventPageRow[]> {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (scope.agentId !== undefined) {
    values.push(scope.agentId);
    clauses.push(`agent_id = $${values.length}`);
  } else if (scope.operatorId !== undefined) {
    values.push(scope.operatorId);
    clauses.push(
      `agent_id IN (SELECT id FROM agents WHERE operator_id = $${values.length})`,
    );
  } else {
    throw new Error("listProtocolEventsPage requires a scope");
  }
  if (after !== null) {
    values.push(after.createdEpoch, after.id);
    clauses.push(
      `(EXTRACT(EPOCH FROM created_at), id) > ($${values.length - 1}, $${values.length})`,
    );
  }
  if (type !== null) {
    values.push(type);
    clauses.push(`type = $${values.length}`);
  }
  values.push(limitPlusOne);
  const result = await query<EventPageRow>(
    `SELECT id, type, agent_id, bond_id, tx_id, actor, policy_version,
       request_id, payload,
       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       EXTRACT(EPOCH FROM created_at)::text AS created_epoch
     FROM protocol_events
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, id ASC
     LIMIT $${values.length}`,
    values as (string | number)[],
    client,
  );
  return result.rows;
}
