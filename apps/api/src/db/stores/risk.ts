/**
 * Risk stores: evidence descriptors (hashes/pointers only), engine-run
 * records, and advisory flags. No raw content is persisted here.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export async function insertEvidenceDescriptor(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly contentHash: string;
    readonly category: string;
    readonly storageRef?: string | null;
    readonly submittedBy: string;
    readonly submittedAt: string;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO evidence_descriptors
       (id, agent_id, content_hash, category, storage_ref, submitted_by, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (agent_id, content_hash) DO NOTHING`,
    [
      input.id,
      input.agentId,
      input.contentHash,
      input.category,
      input.storageRef ?? null,
      input.submittedBy,
      input.submittedAt,
    ],
    client,
  );
}

export interface RiskAnalysisRow {
  readonly id: string;
  readonly agent_id: string;
  readonly engine_version: string;
  readonly ruleset_version: string;
  readonly scoring_version: string;
  readonly score: unknown;
  readonly request_id: string | null;
}

export async function insertRiskAnalysis(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly engineVersion: string;
    readonly rulesetVersion: string;
    readonly scoringVersion: string;
    readonly score: unknown;
    readonly requestId?: string | null;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO risk_analyses
       (id, agent_id, engine_version, ruleset_version, scoring_version, score, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.agentId,
      input.engineVersion,
      input.rulesetVersion,
      input.scoringVersion,
      JSON.stringify(input.score),
      input.requestId ?? null,
    ],
    client,
  );
}

export interface RiskFlagRow {
  readonly id: string;
  readonly agent_id: string;
  readonly analysis_id: string | null;
  readonly category: string;
  readonly severity: string;
  readonly confidence: number;
  readonly evidence_ids: unknown;
  readonly model_version: string;
  readonly status: string;
  readonly supersedes: string | null;
}

export async function insertRiskFlag(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly analysisId?: string | null;
    readonly category: string;
    readonly severity: string;
    readonly confidence: number;
    readonly evidenceIds: readonly string[];
    readonly modelVersion: string;
    readonly status: string;
    readonly supersedes?: string | null;
    readonly detectedAt: string;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO risk_flags
       (id, agent_id, analysis_id, category, severity, confidence,
        evidence_ids, model_version, status, supersedes, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.id,
      input.agentId,
      input.analysisId ?? null,
      input.category,
      input.severity,
      input.confidence,
      JSON.stringify(input.evidenceIds),
      input.modelVersion,
      input.status,
      input.supersedes ?? null,
      input.detectedAt,
    ],
    client,
  );
}

export async function findRiskFlagById(
  id: string,
  client?: PoolClient,
): Promise<RiskFlagRow | null> {
  const result = await query<RiskFlagRow>(
    `SELECT id, agent_id, analysis_id, category, severity, confidence,
       evidence_ids, model_version, status, supersedes
     FROM risk_flags WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export async function listRiskFlagsByAgent(
  agentId: string,
  limit: number,
  client?: PoolClient,
): Promise<RiskFlagRow[]> {
  const result = await query<RiskFlagRow>(
    `SELECT id, agent_id, analysis_id, category, severity, confidence,
       evidence_ids, model_version, status, supersedes
     FROM risk_flags WHERE agent_id = $1
     ORDER BY created_at ASC LIMIT $2`,
    [agentId, limit],
    client,
  );
  return result.rows;
}

export async function updateRiskFlagStatus(
  id: string,
  status: string,
  client?: PoolClient,
): Promise<void> {
  await query(
    "UPDATE risk_flags SET status = $2 WHERE id = $1",
    [id, status],
    client,
  );
}

export async function findRiskAnalysisById(
  id: string,
  client?: PoolClient,
): Promise<RiskAnalysisRow | null> {
  const result = await query<RiskAnalysisRow>(
    `SELECT id, agent_id, engine_version, ruleset_version, scoring_version,
        score, request_id
      FROM risk_analyses WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

/**
 * Phase 20 ledger: one server-written row per analyzed activity.
 * Idempotent on analysis_id: replays never duplicate ledger state.
 */
export async function insertLedgerActivity(
  input: {
    readonly analysisId: string;
    readonly agentId: string;
    readonly actionType: string;
    readonly action: string;
    readonly tool?: string | null;
    readonly amountMinorUnits?: string | null;
    readonly bytesOut?: number | null;
    readonly occurredAt: string;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO agent_activity_ledger
       (analysis_id, agent_id, action_type, action, tool,
        amount_minor_units, bytes_out, occurred_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (analysis_id) DO NOTHING`,
    [
      input.analysisId,
      input.agentId,
      input.actionType,
      input.action,
      input.tool ?? null,
      input.amountMinorUnits ?? null,
      input.bytesOut ?? null,
      input.occurredAt,
    ],
    client,
  );
}

export interface LedgerWindowRow {
  readonly analysis_id: string;
  readonly action: string;
  readonly tool: string | null;
  readonly amount_minor_units: string | null;
  readonly created_at: string;
}

/**
 * Bounded behavioral window: agent-scoped, server-time ordered,
 * hard-limited. Uses activity_ledger_agent_time_idx — never a scan.
 */
export async function listLedgerWindow(
  agentId: string,
  sinceIso: string,
  limit: number,
  client?: PoolClient,
): Promise<LedgerWindowRow[]> {
  const result = await query<LedgerWindowRow>(
    `SELECT analysis_id, action, tool, amount_minor_units, created_at
      FROM agent_activity_ledger
      WHERE agent_id = $1 AND created_at > $2
      ORDER BY created_at DESC LIMIT $3`,
    [agentId, sinceIso, limit],
    client,
  );
  return result.rows;
}

export interface RecentFlagRow {
  readonly category: string;
  readonly status: string;
  readonly created_at: string;
}

/** Bounded prior-flag window for repeat-violation counting. */
export async function listRecentFlagsForBehavior(
  agentId: string,
  sinceIso: string,
  limit: number,
  client?: PoolClient,
): Promise<RecentFlagRow[]> {
  const result = await query<RecentFlagRow>(
    `SELECT category, status, created_at
      FROM risk_flags
      WHERE agent_id = $1 AND created_at > $2
      ORDER BY created_at DESC LIMIT $3`,
    [agentId, sinceIso, limit],
    client,
  );
  return result.rows;
}

/**
 * Opportunistic retention purge (Phase 13 challenge-cleanup pattern):
 * bounded, idempotent, best-effort. Analyses/flags (the audit trail)
 * are never purged — only the behavioral feature rows.
 */
export async function purgeOldLedgerEntries(
  olderThanDays: number,
  limit: number,
): Promise<number> {
  const result = await query(
    `DELETE FROM agent_activity_ledger WHERE ctid IN (
       SELECT ctid FROM agent_activity_ledger
       WHERE created_at < now() - ($1 || ' days')::interval
       LIMIT $2
     )`,
    [String(olderThanDays), limit],
  );
  return result.rowCount ?? 0;
}
