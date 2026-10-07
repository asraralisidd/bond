/**
 * Phase 21 event-sourced reputation stores.
 *
 * agent_reputation: one upserted row per agent (current state).
 * reputation_events: immutable append-only log; duplicates of the
 * same protocol outcome are rejected by UNIQUE (agent_id,
 * source_type, source_id) and writers use ON CONFLICT DO NOTHING.
 * No UPDATE/DELETE accessors exist by design.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

/** Deterministic event id: same source ⇒ same id, replay-safe. */
export function reputationEventId(
  sourceType: string,
  sourceId: string,
): string {
  return `repev-${sourceType}-${sourceId}`;
}

export interface AgentReputationRow {
  readonly agent_id: string;
  readonly score: number;
  readonly trust_level: string;
  readonly version: string;
  readonly updated_at: string;
}

export async function getAgentReputation(
  agentId: string,
  client?: PoolClient,
): Promise<AgentReputationRow | null> {
  const result = await query<AgentReputationRow>(
    `SELECT agent_id, score, trust_level, version, updated_at
      FROM agent_reputation WHERE agent_id = $1`,
    [agentId],
    client,
  );
  return result.rows[0] ?? null;
}

/** FOR UPDATE variant: serializes concurrent event applications. */
export async function getAgentReputationForUpdate(
  agentId: string,
  client: PoolClient,
): Promise<AgentReputationRow | null> {
  const result = await query<AgentReputationRow>(
    `SELECT agent_id, score, trust_level, version, updated_at
      FROM agent_reputation WHERE agent_id = $1 FOR UPDATE`,
    [agentId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function upsertAgentReputation(
  input: {
    readonly agentId: string;
    readonly score: number;
    readonly trustLevel: string;
    readonly version: string;
    readonly updatedAt: string;
  },
  client: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO agent_reputation
       (agent_id, score, trust_level, version, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (agent_id) DO UPDATE SET
        score = EXCLUDED.score,
        trust_level = EXCLUDED.trust_level,
        version = EXCLUDED.version,
        updated_at = EXCLUDED.updated_at`,
    [
      input.agentId,
      input.score,
      input.trustLevel,
      input.version,
      input.updatedAt,
    ],
    client,
  );
}

export interface ReputationEventRow {
  readonly id: string;
  readonly agent_id: string;
  readonly event_type: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly impact: number;
  readonly score_before: number;
  readonly score_after: number;
  readonly reason_code: string;
  readonly reason: string;
  readonly reputation_version: string;
  readonly created_at: string;
}

/**
 * Idempotent insert: returns true when the event was applied, false
 * when the same protocol outcome was already recorded.
 */
export async function insertReputationEvent(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly eventType: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly impact: number;
    readonly scoreBefore: number;
    readonly scoreAfter: number;
    readonly reasonCode: string;
    readonly reason: string;
    readonly reputationVersion: string;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await query(
    `INSERT INTO reputation_events
       (id, agent_id, event_type, source_type, source_id, impact,
        score_before, score_after, reason_code, reason,
        reputation_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (agent_id, source_type, source_id) DO NOTHING
      RETURNING id`,
    [
      input.id,
      input.agentId,
      input.eventType,
      input.sourceType,
      input.sourceId,
      input.impact,
      input.scoreBefore,
      input.scoreAfter,
      input.reasonCode,
      input.reason,
      input.reputationVersion,
    ],
    client,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function findReputationEvent(
  agentId: string,
  sourceType: string,
  sourceId: string,
  client?: PoolClient,
): Promise<ReputationEventRow | null> {
  const result = await query<ReputationEventRow>(
    `SELECT id, agent_id, event_type, source_type, source_id, impact,
        score_before, score_after, reason_code, reason,
        reputation_version, created_at
      FROM reputation_events
      WHERE agent_id = $1 AND source_type = $2 AND source_id = $3`,
    [agentId, sourceType, sourceId],
    client,
  );
  return result.rows[0] ?? null;
}

/** Bounded recent-history read (newest first, hard-limited). */
export async function listReputationEvents(
  agentId: string,
  limit: number,
  client?: PoolClient,
): Promise<ReputationEventRow[]> {
  const result = await query<ReputationEventRow>(
    `SELECT id, agent_id, event_type, source_type, source_id, impact,
        score_before, score_after, reason_code, reason,
        reputation_version, created_at
      FROM reputation_events WHERE agent_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit],
    client,
  );
  return result.rows;
}
