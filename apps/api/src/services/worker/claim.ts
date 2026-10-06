/**
 * Job claiming: one atomic statement per batch. Concurrent workers never
 * process the same row: SKIP LOCKED skips rows locked by another
 * claimant, and the lease check lets a new worker recover rows whose
 * previous holder died mid-claim.
 *
 * Claiming bumps attempts exactly once. Execution happens OUTSIDE any
 * database transaction (network I/O must never hold row locks).
 */
import type { PoolClient } from "pg";
import { withTransaction } from "../../db/pool.js";
import { claimPendingTransactions } from "../../db/stores/chain.js";
import type { ChainTxRow } from "../../db/stores/chain.js";

export interface ClaimInput {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly limit: number;
  readonly nowIso: string;
}

export async function claimJobs(input: ClaimInput): Promise<ChainTxRow[]> {
  return withTransaction(async (client: PoolClient) => {
    return claimPendingTransactions(
      {
        workerId: input.workerId,
        leaseMs: input.leaseMs,
        limit: input.limit,
        nowIso: input.nowIso,
      },
      client,
    );
  });
}
