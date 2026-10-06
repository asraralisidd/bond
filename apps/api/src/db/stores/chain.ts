/**
 * Chain-support stores: transactions, idempotency keys, nullifier mirror,
 * eligibility proofs, and sync checkpoints.
 *
 * Nullifier rows are a local dedupe aid only — Midnight consumption is
 * authoritative for chain effects. All writes use parameterized SQL.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface ChainTxRow {
  readonly id: string;
  readonly purpose: string;
  readonly agent_id: string | null;
  readonly bond_id: string | null;
  readonly idempotency_key: string;
  readonly status: string;
  readonly chain_tx_id: string | null;
  readonly nullifier: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly confirmed_at: string | null;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly next_attempt_at: string | null;
  readonly max_attempts: number;
  readonly reconciliation_required: boolean;
  readonly dead_letter: boolean;
}

export async function insertChainTransaction(
  input: {
    readonly id: string;
    readonly purpose: string;
    readonly agentId?: string | null;
    readonly bondId?: string | null;
    readonly idempotencyKey: string;
    readonly status: string;
    readonly chainTxId?: string | null;
    readonly nullifier?: string | null;
    readonly params?: unknown;
  },
  client?: PoolClient,
): Promise<ChainTxRow> {
  const result = await query<ChainTxRow>(
    `INSERT INTO chain_transactions
       (id, purpose, agent_id, bond_id, idempotency_key, status,
        chain_tx_id, nullifier, params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at`,
    [
      input.id,
      input.purpose,
      input.agentId ?? null,
      input.bondId ?? null,
      input.idempotencyKey,
      input.status,
      input.chainTxId ?? null,
      input.nullifier ?? null,
      JSON.stringify(input.params ?? {}),
    ],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insertChainTransaction returned no row");
  }
  return row;
}

export async function findChainTransactionById(
  id: string,
  client?: PoolClient,
): Promise<ChainTxRow | null> {
  const result = await query<ChainTxRow>(
    `SELECT id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
     FROM chain_transactions WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

/**
 * Row-locked read for state transitions. Must be called inside an
 * explicit transaction (withTransaction): concurrent advancers of the
 * same transaction serialize here instead of racing check-then-act.
 */
export async function findChainTransactionByIdForUpdate(
  id: string,
  client: PoolClient,
): Promise<ChainTxRow | null> {
  const result = await query<ChainTxRow>(
    `SELECT id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
     FROM chain_transactions WHERE id = $1 FOR UPDATE`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export async function findChainTransactionByIdempotencyKey(
  key: string,
  client?: PoolClient,
): Promise<ChainTxRow | null> {
  const result = await query<ChainTxRow>(
    `SELECT id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
     FROM chain_transactions WHERE idempotency_key = $1`,
    [key],
    client,
  );
  return result.rows[0] ?? null;
}

export async function updateChainTransaction(
  id: string,
  update: {
    readonly status?: string;
    readonly chainTxId?: string | null;
    readonly lastError?: string | null;
    readonly confirmed?: boolean;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `UPDATE chain_transactions SET
       status = COALESCE($2, status),
       chain_tx_id = COALESCE($3, chain_tx_id),
       last_error = $4,
       attempts = attempts + 1,
       confirmed_at = CASE WHEN $5 THEN now() ELSE confirmed_at END,
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      update.status ?? null,
      update.chainTxId ?? null,
      update.lastError ?? null,
      update.confirmed ?? false,
    ],
    client,
  );
}

export async function listPendingChainTransactions(
  limit: number,
  client?: PoolClient,
): Promise<ChainTxRow[]> {
  const result = await query<ChainTxRow>(
    `SELECT id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
     FROM chain_transactions
     WHERE status IN ('PENDING', 'SUBMITTED')
     ORDER BY created_at ASC LIMIT $1`,
    [limit],
    client,
  );
  return result.rows;
}

export interface IdempotencyRow {
  readonly key: string;
  readonly operator_id: string;
  readonly route: string;
  readonly request_fingerprint: string;
  readonly status: string;
  readonly response_snapshot: unknown;
}

export type IdempotencyClaimOutcome = "claimed" | "replayed" | "conflict";

export interface IdempotencyClaim {
  readonly outcome: IdempotencyClaimOutcome;
  readonly row: IdempotencyRow | null;
  readonly reclaimed: boolean;
}

/**
 * Lease model (all mutations conditional-atomic, safe under concurrency):
 * - INSERT wins → "claimed" (fresh lease).
 * - Same fingerprint + completed + unexpired → "replayed".
 * - Same fingerprint + completed + expired → reclaim (fresh execution).
 * - Same fingerprint + in-progress + unexpired → "conflict" (active lease).
 * - Same fingerprint + in-progress + expired (stale holder) → reclaim.
 * - Same fingerprint + failed → "conflict" (client must mint a new key).
 * - Different fingerprint + unexpired → "conflict" (fail closed).
 * - Different fingerprint + expired → reclaim (original outcome is gone).
 *
 * Reclaim is a single conditional UPDATE; losers re-read and see the
 * winner's fresh lease, so concurrent identical requests converge to a
 * single execution. Expired rows are never silently deleted while
 * active; reclaimed rows are overwritten with the new request.
 */
export async function claimIdempotencyKey(input: {
  readonly key: string;
  readonly operatorId: string;
  readonly route: string;
  readonly fingerprint: string;
  readonly ttlHours?: number;
  readonly client?: PoolClient;
}): Promise<IdempotencyClaim> {
  const ttl = input.ttlHours ?? 24;
  const inserted = await query<IdempotencyRow>(
    `INSERT INTO idempotency_keys
       (key, operator_id, route, request_fingerprint, status,
        expires_at)
     VALUES ($1, $2, $3, $4, 'in-progress',
       now() + (($5 || ' hours')::interval))
     ON CONFLICT (key) DO NOTHING
     RETURNING key, operator_id, route, request_fingerprint, status,
       response_snapshot`,
    [input.key, input.operatorId, input.route, input.fingerprint, String(ttl)],
    input.client,
  );
  if (inserted.rows[0]) {
    return { outcome: "claimed", row: inserted.rows[0], reclaimed: false };
  }
  const existing = await query<IdempotencyRow & { expired: boolean }>(
    `SELECT key, operator_id, route, request_fingerprint, status,
       response_snapshot, (expires_at < now()) AS expired
     FROM idempotency_keys WHERE key = $1`,
    [input.key],
    input.client,
  );
  const row = existing.rows[0] ?? null;
  if (!row) {
    return { outcome: "conflict", row: null, reclaimed: false };
  }
  const sameFingerprint = row.request_fingerprint === input.fingerprint;
  if (row.status === "completed" && sameFingerprint && !row.expired) {
    return { outcome: "replayed", row, reclaimed: false };
  }
  if (row.status === "failed") {
    return { outcome: "conflict", row, reclaimed: false };
  }
  const reclaimable =
    (row.status === "completed" && row.expired) ||
    (row.status === "in-progress" && row.expired) ||
    (!sameFingerprint && row.expired);
  if (!reclaimable) {
    return { outcome: "conflict", row, reclaimed: false };
  }
  const reclaimed = await query<IdempotencyRow>(
    `UPDATE idempotency_keys SET
       operator_id = $2, route = $3, request_fingerprint = $4,
       status = 'in-progress', response_snapshot = NULL,
       expires_at = now() + (($5 || ' hours')::interval)
     WHERE key = $1 AND expires_at < now()
     RETURNING key, operator_id, route, request_fingerprint, status,
       response_snapshot`,
    [input.key, input.operatorId, input.route, input.fingerprint, String(ttl)],
    input.client,
  );
  if (reclaimed.rows[0]) {
    return { outcome: "claimed", row: reclaimed.rows[0], reclaimed: true };
  }
  const reread = await query<IdempotencyRow>(
    `SELECT key, operator_id, route, request_fingerprint, status,
       response_snapshot
     FROM idempotency_keys WHERE key = $1`,
    [input.key],
    input.client,
  );
  const winner = reread.rows[0] ?? null;
  if (
    winner &&
    winner.status === "completed" &&
    winner.request_fingerprint === input.fingerprint
  ) {
    return { outcome: "replayed", row: winner, reclaimed: false };
  }
  return { outcome: "conflict", row: winner, reclaimed: false };
}

export async function completeIdempotencyKey(
  key: string,
  responseSnapshot: unknown,
  client?: PoolClient,
): Promise<void> {
  await query(
    "UPDATE idempotency_keys SET status = 'completed', response_snapshot = $2 WHERE key = $1",
    [key, JSON.stringify(responseSnapshot)],
    client,
  );
}

export async function failIdempotencyKey(
  key: string,
  client?: PoolClient,
): Promise<void> {
  await query(
    "UPDATE idempotency_keys SET status = 'failed' WHERE key = $1",
    [key],
    client,
  );
}

export async function consumeNullifier(
  domain: string,
  key: string,
  client?: PoolClient,
): Promise<boolean> {
  const result = await query<{ key: string }>(
    `INSERT INTO nullifiers (domain, key) VALUES ($1, $2)
     ON CONFLICT (domain, key) DO NOTHING RETURNING key`,
    [domain, key],
    client,
  );
  return result.rows.length > 0;
}

export async function isNullifierConsumed(
  domain: string,
  key: string,
  client?: PoolClient,
): Promise<boolean> {
  const result = await query<{ key: string }>(
    "SELECT key FROM nullifiers WHERE domain = $1 AND key = $2",
    [domain, key],
    client,
  );
  return result.rows.length > 0;
}

export interface EligibilityProofRow {
  readonly id: string;
  readonly agent_id: string;
  readonly bond_id: string;
  readonly policy_version: string;
  readonly purpose: string;
  readonly required_minimum_minor_units: string;
  readonly proof_nullifier: string;
  readonly redemption_nullifier: string | null;
  readonly status: string;
  readonly expires_at: string;
  readonly tx_id: string | null;
}

export async function insertEligibilityProof(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly bondId: string;
    readonly policyVersion: string;
    readonly purpose: string;
    readonly requiredMinimumMinorUnits: string;
    readonly proofNullifier: string;
    readonly status: string;
    readonly expiresAt: string;
    readonly txId?: string | null;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO eligibility_proofs
       (id, agent_id, bond_id, policy_version, purpose,
        required_minimum_minor_units, proof_nullifier, status, expires_at,
        tx_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.agentId,
      input.bondId,
      input.policyVersion,
      input.purpose,
      input.requiredMinimumMinorUnits,
      input.proofNullifier,
      input.status,
      input.expiresAt,
      input.txId ?? null,
    ],
    client,
  );
}

export async function findEligibilityProofById(
  id: string,
  client?: PoolClient,
): Promise<EligibilityProofRow | null> {
  const result = await query<EligibilityProofRow>(
    `SELECT id, agent_id, bond_id, policy_version, purpose,
       required_minimum_minor_units, proof_nullifier, redemption_nullifier,
       status,
       to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
       tx_id
     FROM eligibility_proofs WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export async function updateEligibilityProof(
  id: string,
  update: {
    readonly status?: string;
    readonly redemptionNullifier?: string | null;
    readonly txId?: string | null;
  },
  client?: PoolClient,
): Promise<void> {
  await query(
    `UPDATE eligibility_proofs SET
       status = COALESCE($2, status),
       redemption_nullifier = COALESCE($3, redemption_nullifier),
       tx_id = COALESCE($4, tx_id),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      update.status ?? null,
      update.redemptionNullifier ?? null,
      update.txId ?? null,
    ],
    client,
  );
}

export async function getSyncCheckpoint(
  contractAddress: string,
  client?: PoolClient,
): Promise<{ last_marker: string | null; conflicts_count: number } | null> {
  const result = await query<{
    last_marker: string | null;
    conflicts_count: number;
  }>(
    "SELECT last_marker, conflicts_count FROM sync_checkpoints WHERE contract_address = $1",
    [contractAddress],
    client,
  );
  return result.rows[0] ?? null;
}

export async function upsertSyncCheckpoint(
  contractAddress: string,
  lastMarker: string | null,
  conflictDelta: number,
  client?: PoolClient,
): Promise<void> {
  await query(
    `INSERT INTO sync_checkpoints (contract_address, last_marker, conflicts_count, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (contract_address) DO UPDATE SET
       last_marker = COALESCE(EXCLUDED.last_marker, sync_checkpoints.last_marker),
       conflicts_count = sync_checkpoints.conflicts_count + EXCLUDED.conflicts_count,
       updated_at = now()`,
    [contractAddress, lastMarker, conflictDelta],
    client,
  );
}

export interface TxClaimInput {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly limit: number;
  readonly nowIso: string;
}

/**
 * Atomically claims due PENDING jobs for one worker. A row is claimable
 * when it is PENDING, scheduled (next_attempt_at passed or unset), not
 * dead-lettered, and unclaimed or lease-expired. SKIP LOCKED lets
 * concurrent workers divide work without waiting on each other.
 * Claiming sets attempts = attempts + 1 exactly once per claim.
 */
export async function claimPendingTransactions(
  input: TxClaimInput,
  client: PoolClient,
): Promise<ChainTxRow[]> {
  const result = await query<ChainTxRow>(
    `UPDATE chain_transactions AS t SET
       claimed_by = $1,
       claimed_at = $2,
       attempts = attempts + 1,
       updated_at = now()
     WHERE t.id IN (
       SELECT c.id FROM chain_transactions AS c
       WHERE c.status = 'PENDING'
         AND c.dead_letter = FALSE
         AND c.reconciliation_required = FALSE
         AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= $2)
         AND (c.claimed_by IS NULL OR c.claimed_at < $2::timestamptz - make_interval(secs => $3))
       ORDER BY c.created_at ASC
       LIMIT $4
       FOR UPDATE SKIP LOCKED
     )
     RETURNING t.id, t.purpose, t.agent_id, t.bond_id, t.idempotency_key,
       t.status, t.chain_tx_id, t.nullifier, t.attempts, t.last_error,
       t.claimed_by, t.claimed_at,
       to_char(t.next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       t.max_attempts, t.reconciliation_required, t.dead_letter,
       to_char(t.confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at`,
    [input.workerId, input.nowIso, input.leaseMs / 1000, input.limit],
    client,
  );
  return result.rows;
}

/** Releases a claim so the row becomes claimable again (lease expired). */
export async function releaseTxClaim(
  id: string,
  client: PoolClient,
): Promise<void> {
  await query(
    `UPDATE chain_transactions SET claimed_by = NULL, claimed_at = NULL,
       updated_at = now() WHERE id = $1`,
    [id],
    client,
  );
}

/** Schedules the next attempt with backoff; releases the claim. */
export async function scheduleTxRetry(
  id: string,
  nextAttemptAt: string,
  lastError: string,
  client: PoolClient,
): Promise<void> {
  await query(
    `UPDATE chain_transactions SET claimed_by = NULL, claimed_at = NULL,
       next_attempt_at = $2, last_error = $3, updated_at = now()
     WHERE id = $1`,
    [id, nextAttemptAt, lastError],
    client,
  );
}

/** Terminal failure: FAILED + dead-lettered, claim released. */
export async function markTxDeadLetter(
  id: string,
  lastError: string,
  client: PoolClient,
): Promise<void> {
  await query(
    `UPDATE chain_transactions SET status = 'FAILED', dead_letter = TRUE,
       claimed_by = NULL, claimed_at = NULL, last_error = $2,
       updated_at = now()
     WHERE id = $1`,
    [id, lastError],
    client,
  );
}

/** Marks a row as needing reconciliation (uncertain outcome, never blind retry). */
export async function markReconciliationRequired(
  id: string,
  lastError: string,
  client: PoolClient,
): Promise<void> {
  await query(
    `UPDATE chain_transactions SET reconciliation_required = TRUE,
       claimed_by = NULL, claimed_at = NULL, last_error = $2,
       updated_at = now()
     WHERE id = $1`,
    [id, lastError],
    client,
  );
}

export async function clearReconciliationRequired(
  id: string,
  client: PoolClient,
): Promise<void> {
  await query(
    `UPDATE chain_transactions SET reconciliation_required = FALSE,
       updated_at = now()
     WHERE id = $1`,
    [id],
    client,
  );
}

/** SUBMITTED rows older than the threshold that still need attention. */
export async function findStuckSubmitted(
  olderThanIso: string,
  limit: number,
  client?: PoolClient,
): Promise<ChainTxRow[]> {
  const result = await query<ChainTxRow>(
    `SELECT id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
     FROM chain_transactions
     WHERE status = 'SUBMITTED' AND dead_letter = FALSE
       AND updated_at < $1
     ORDER BY updated_at ASC LIMIT $2`,
    [olderThanIso, limit],
    client,
  );
  return result.rows;
}

/** Rows flagged for reconciliation, oldest first. */
export async function findReconciliationRequired(
  limit: number,
  client?: PoolClient,
): Promise<ChainTxRow[]> {
  const result = await query<ChainTxRow>(
    `SELECT id, purpose, agent_id, bond_id, idempotency_key, status,
       chain_tx_id, nullifier, attempts, last_error,
       claimed_by, claimed_at,
       to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
       max_attempts, reconciliation_required, dead_letter,
       to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
     FROM chain_transactions
     WHERE reconciliation_required = TRUE AND dead_letter = FALSE
     ORDER BY updated_at ASC LIMIT $1`,
    [limit],
    client,
  );
  return result.rows;
}
