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
