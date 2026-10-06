/**
 * Protocol event writer. Payloads must be privacy-scrubbed by callers;
 * this module adds IDs, timestamps, and correlation only.
 *
 * Accepts an optional transaction client so the event commits atomically
 * with the state change it describes (see withTransaction in db/pool.ts).
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { insertProtocolEvent } from "../db/stores/events.js";

export interface ServiceEvent {
  readonly type: string;
  readonly agentId?: string | null;
  readonly bondId?: string | null;
  readonly txId?: string | null;
  readonly actor: string;
  readonly policyVersion?: string | null;
  readonly requestId?: string | null;
  readonly payload?: unknown;
}

export async function recordEvent(
  event: ServiceEvent,
  client?: PoolClient,
): Promise<string> {
  const id = randomUUID();
  await insertProtocolEvent(
    {
      id,
      type: event.type,
      agentId: event.agentId,
      bondId: event.bondId,
      txId: event.txId,
      actor: event.actor,
      policyVersion: event.policyVersion,
      requestId: event.requestId,
      payload: event.payload ?? {},
    },
    client,
  );
  return id;
}
