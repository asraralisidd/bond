/**
 * Worker shared types. The worker is an execution mechanism, not an
 * authority: it runs persisted, authorized intents through the Midnight
 * Adapter and records outcomes. It never decides slashing, never calls
 * the Risk Engine, and never invents chain state.
 */
import type { ChainTxRow } from "../../db/stores/chain.js";

export type WorkerPhase = "STARTING" | "RUNNING" | "DRAINING" | "STOPPED";

export type FailureClass =
  "RETRYABLE" | "PERMANENT" | "ALREADY_COMPLETED" | "REQUIRES_RECONCILIATION";

export interface ClassifiedFailure {
  readonly failureClass: FailureClass;
  /** Operator-safe message (no credentials, witnesses, or amounts). */
  readonly message: string;
}

export interface WorkerStats {
  polls: number;
  claimed: number;
  submitted: number;
  confirmed: number;
  retried: number;
  deadLettered: number;
  reconciled: number;
  stuckSubmitted: number;
  lastPollAt: string | null;
  lastError: string | null;
  activeJobs: number;
}

export interface WorkerSnapshot {
  readonly enabled: boolean;
  readonly phase: WorkerPhase;
  readonly workerId: string;
  readonly stats: WorkerStats;
}

export interface ClaimedJob {
  readonly row: ChainTxRow;
}

/** Outcome of executing one claimed job (submit stage). */
export type JobExecutionOutcome =
  | { readonly kind: "submitted"; readonly chainTxId: string | null }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "uncertain"; readonly error: unknown };
