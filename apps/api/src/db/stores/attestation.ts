/**
 * Attestation stores: attestor registry, attestation records with
 * verdicts/decision JSONB, immutable-on-complete slash events, and
 * event-sourced reputation snapshots.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export async function upsertAttestor(
  input: {
    readonly id: string;
    readonly organization: string;
    readonly status: string;
    readonly independence?: unknown;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO attestors (id, organization, status, independence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       organization = EXCLUDED.organization,
       status = EXCLUDED.status,
       independence = EXCLUDED.independence`,
    [
      input.id,
      input.organization,
      input.status,
      JSON.stringify(input.independence ?? {}),
    ],
    client,
  );
}

export async function findAttestorById(
  id: string,
  client?: PoolClient,
): Promise<{ id: string; organization: string; status: string } | null> {
  const result = await query<{
    id: string;
    organization: string;
    status: string;
  }>(
    "SELECT id, organization, status FROM attestors WHERE id = $1",
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export interface AttestationRow {
  readonly id: string;
  readonly flag_id: string;
  readonly agent_id: string;
  readonly threshold: number;
  readonly policy_version: string;
  readonly verdicts: unknown;
  readonly status: string;
  readonly decision: unknown;
  readonly requested_at: string;
  readonly expires_at: string;
}

export async function insertAttestation(
  input: {
    readonly id: string;
    readonly flagId: string;
    readonly agentId: string;
    readonly threshold: number;
    readonly policyVersion: string;
    readonly status: string;
    readonly requestedAt: string;
    readonly expiresAt: string;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO attestations
       (id, flag_id, agent_id, threshold, policy_version, status, requested_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.flagId,
      input.agentId,
      input.threshold,
      input.policyVersion,
      input.status,
      input.requestedAt,
      input.expiresAt,
    ],
    client,
  );
}

export async function findAttestationById(
  id: string,
  client?: PoolClient,
): Promise<AttestationRow | null> {
  const result = await query<AttestationRow>(
    `SELECT id, flag_id, agent_id, threshold, policy_version, verdicts,
       status, decision,
       to_char(requested_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
       to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
     FROM attestations WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export async function updateAttestation(
  id: string,
  update: { verdicts: unknown; status: string; decision: unknown },
  client?: PoolClient,
): Promise<void> {
  await query(
    "UPDATE attestations SET verdicts = $2, status = $3, decision = $4 WHERE id = $1",
    [
      id,
      JSON.stringify(update.verdicts),
      update.status,
      JSON.stringify(update.decision),
    ],
    client,
  );
}

export async function insertSlashEvent(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly bondId: string;
    readonly attestationId: string;
    readonly decisionId: string;
    readonly flagId: string;
    readonly category: string;
    readonly severity: string;
    readonly amountMinorUnits: string;
    readonly isFullSlash: boolean;
    readonly status: string;
    readonly txId?: string | null;
    readonly initiatedAt: string;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO slash_events
       (id, agent_id, bond_id, attestation_id, decision_id, flag_id,
        category, severity, amount_minor_units, is_full_slash, status,
        tx_id, initiated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.id,
      input.agentId,
      input.bondId,
      input.attestationId,
      input.decisionId,
      input.flagId,
      input.category,
      input.severity,
      input.amountMinorUnits,
      input.isFullSlash,
      input.status,
      input.txId ?? null,
      input.initiatedAt,
    ],
    client,
  );
}

export async function completeSlashEvent(
  id: string,
  completedAt: string,
  client?: PoolClient,
): Promise<void> {
  await query(
    `UPDATE slash_events SET status = 'completed', completed_at = $2
     WHERE id = $1 AND status = 'initiated'`,
    [id, completedAt],
    client,
  );
}

export async function listSlashEventsByAgent(
  agentId: string,
  limit: number,
  client?: PoolClient,
): Promise<
  {
    id: string;
    bond_id: string;
    category: string;
    severity: string;
    is_full_slash: boolean;
    status: string;
  }[]
> {
  const result = await query<{
    id: string;
    bond_id: string;
    category: string;
    severity: string;
    is_full_slash: boolean;
    status: string;
  }>(
    `SELECT id, bond_id, category, severity, is_full_slash, status
     FROM slash_events WHERE agent_id = $1
     ORDER BY initiated_at ASC LIMIT $2`,
    [agentId, limit],
    client,
  );
  return result.rows;
}

export async function insertReputationRecord(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly score: number;
    readonly standing: string;
    readonly factors: unknown;
    readonly triggeredByEvent: string;
    readonly modelVersion: string;
    readonly updatedAt: string;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO reputation_records
       (id, agent_id, score, standing, factors, triggered_by_event,
        model_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.agentId,
      input.score,
      input.standing,
      JSON.stringify(input.factors),
      input.triggeredByEvent,
      input.modelVersion,
      input.updatedAt,
    ],
    client,
  );
}

export async function latestReputationByAgent(
  agentId: string,
  client?: PoolClient,
): Promise<{ score: number; standing: string } | null> {
  const result = await query<{ score: number; standing: string }>(
    `SELECT score, standing FROM reputation_records
     WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [agentId],
    client,
  );
  return result.rows[0] ?? null;
}
