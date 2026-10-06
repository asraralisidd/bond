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
