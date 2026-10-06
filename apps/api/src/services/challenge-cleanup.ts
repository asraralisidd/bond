/**
 * Wallet challenge expiry cleanup (Phase 13).
 *
 * Deletes expired-and-unconsumed challenges. Consumed challenges are
 * retained for audit trail. Idempotent: safe to run repeatedly. Uses
 * the existing wallet_challenges_expires_idx.
 *
 * Race safety: verification uses atomic UPDATE WHERE consumed_at IS NULL
 * inside a transaction, so a concurrent purge cannot delete a challenge
 * mid-verification. Purge only targets rows where consumed_at IS NULL
 * AND expires_at < now(), which are by definition no longer verifiable.
 */
import { query } from "../db/pool.js";

export interface PurgeResult {
  readonly deleted: number;
}

export async function purgeExpiredChallenges(): Promise<PurgeResult> {
  const result = await query(
    `DELETE FROM wallet_challenges
     WHERE consumed_at IS NULL AND expires_at < now()`,
  );
  return { deleted: result.rowCount ?? 0 };
}
