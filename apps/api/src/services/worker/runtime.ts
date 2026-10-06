/**
 * Worker runtime: poll → claim → execute → persist, with graceful drain.
 *
 * The runtime is an execution mechanism, not an authority. It only runs
 * persisted, authorized intents through registered purpose executors and
 * the Midnight Adapter. It never calls the Risk Engine, never evaluates
 * attestations, and never invents chain state.
 *
 * Crash tolerance comes from the database, not memory: claims carry
 * leases, outcomes are recorded transactionally, and an uncertain REAL
 * submission is flagged for reconciliation instead of retried blindly.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ChainHandle } from "@bond/midnight-adapter";
import { withTransaction } from "../../db/pool.js";
import {
  clearReconciliationRequired,
  findChainTransactionByIdForUpdate,
  findReconciliationRequired,
  findStuckSubmitted,
  markReconciliationRequired,
  markTxDeadLetter,
  releaseTxClaim,
  scheduleTxRetry,
  updateChainTransaction,
} from "../../db/stores/chain.js";
import type { ChainTxRow } from "../../db/stores/chain.js";
import {
  confirmTransactionService,
  getPurposeExecutor,
} from "../transactions.js";
import {
  runReconciliationOnce,
  reconcileTransactionRows,
} from "../reconcile.js";
import { systemPrincipal } from "../../http/principals.js";
import { emptyLogMetadata } from "@bond/shared-types";
import { DomainError } from "@bond/shared-types";
import type { TransactionId } from "@bond/shared-types";
import { logError, logInfo } from "../../observability.js";
import { recordEvent } from "../events.js";
import { addMsIso, computeBackoffDelayMs } from "./backoff.js";
import { classifyFailure, safeFailureMessage } from "./classify.js";
import { claimJobs } from "./claim.js";
import type { WorkerConfig } from "./config.js";
import type {
  JobExecutionOutcome,
  WorkerPhase,
  WorkerSnapshot,
  WorkerStats,
} from "./types.js";

export interface RuntimeDeps {
  readonly config: WorkerConfig;
  readonly workerId?: string;
  readonly resolveHandle: () => ChainHandle | null;
  readonly contractAddress?: string | null;
  readonly clock?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ActiveJob {
  readonly txId: string;
  readonly startedAt: string;
}

function workerLog(
  operation: string,
  message: string,
  transactionId?: string,
): void {
  logInfo(
    {
      metadata: {
        ...emptyLogMetadata(),
        transactionId: (transactionId ?? null) as TransactionId | null,
      },
      operation: `worker:${operation}`,
    },
    message,
  );
}

function workerLogError(
  operation: string,
  message: string,
  transactionId?: string,
): void {
  logError(
    {
      metadata: {
        ...emptyLogMetadata(),
        transactionId: (transactionId ?? null) as TransactionId | null,
      },
      operation: `worker:${operation}`,
    },
    message,
  );
}

function newWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function emptyStats(): WorkerStats {
  return {
    polls: 0,
    claimed: 0,
    submitted: 0,
    confirmed: 0,
    retried: 0,
    deadLettered: 0,
    reconciled: 0,
    stuckSubmitted: 0,
    lastPollAt: null,
    lastError: null,
    activeJobs: 0,
  };
}

function createSettlingReader(getPhase: () => WorkerPhase): () => boolean {
  return () => {
    const current = getPhase();
    return current === "DRAINING" || current === "STOPPED";
  };
}

export interface WorkerRuntime {
  readonly phase: () => WorkerPhase;
  readonly snapshot: () => WorkerSnapshot;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly runOnce: () => Promise<void>;
}

export function createWorkerRuntime(deps: RuntimeDeps): WorkerRuntime {
  const workerId = deps.workerId ?? newWorkerId();
  const clock = deps.clock ?? (() => new Date().toISOString());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const actor = systemPrincipal("worker").id;
  let phase: WorkerPhase = "STARTING";
  let stopped = false;
  let looping = false;
  let lastReconcileAt: string | null = null;
  const active = new Map<string, ActiveJob>();
  const stats = emptyStats();
  const settling = createSettlingReader(() => phase);

  async function executeSubmit(
    handle: ChainHandle,
    row: ChainTxRow,
  ): Promise<JobExecutionOutcome> {
    // Resume without resubmission: a recorded chain reference means a
    // previous attempt already submitted (crash between submit and
    // persist). Never submit twice for one intent.
    if (row.chain_tx_id) {
      return { kind: "submitted", chainTxId: row.chain_tx_id };
    }
    if (handle.mode === "REAL") {
      // REAL submission requires a wallet-attended flow that the
      // background worker must never improvise. Flag for reconciliation
      // instead of submitting blindly or failing the intent.
      return {
        kind: "uncertain",
        error: new Error("REAL submission requires operator attention"),
      };
    }
    const executor = getPurposeExecutor(row.purpose);
    if (!executor) {
      return {
        kind: "failed",
        error: new DomainError(
          "INVALID_IDENTIFIER",
          `No executor for purpose ${row.purpose}`,
          { purpose: row.purpose },
        ),
      };
    }
    try {
      const result = await executor(handle, row);
      if (result.status === "SUBMITTED") {
        return { kind: "submitted", chainTxId: result.txId };
      }
      return {
        kind: "failed",
        error: new Error(result.errorCode ?? "SIMULATED_FAILURE"),
      };
    } catch (error) {
      return { kind: "uncertain", error };
    }
  }

  async function settleSubmit(
    row: ChainTxRow,
    outcome: JobExecutionOutcome,
  ): Promise<void> {
    if (outcome.kind === "submitted") {
      await withTransaction(async (client) => {
        const fresh = await findChainTransactionByIdForUpdate(row.id, client);
        if (!fresh || fresh.status !== "PENDING") {
          return;
        }
        await updateChainTransaction(
          row.id,
          { status: "SUBMITTED", chainTxId: outcome.chainTxId },
          client,
        );
        await recordEvent(
          {
            type: "TRANSACTION_STATUS_CHANGED",
            agentId: fresh.agent_id,
            bondId: fresh.bond_id,
            txId: row.id,
            actor,
            payload: {
              transactionId: row.id,
              from: fresh.status,
              to: "SUBMITTED",
            },
          },
          client,
        );
        await releaseTxClaim(row.id, client);
      });
      stats.submitted += 1;
      workerLog("submitted", `Submitted ${row.id}`, row.id);
      return;
    }
    const failureClass = classifyFailure(outcome.error);
    if (failureClass === "REQUIRES_RECONCILIATION") {
      await withTransaction(async (client) => {
        await markReconciliationRequired(
          row.id,
          safeFailureMessage(outcome.error),
          client,
        );
        await recordEvent(
          {
            type: "TRANSACTION_STATUS_CHANGED",
            agentId: row.agent_id,
            bondId: row.bond_id,
            txId: row.id,
            actor,
            payload: {
              transactionId: row.id,
              from: row.status,
              to: row.status,
              note: "uncertain-submission",
            },
          },
          client,
        );
      });
      workerLogError(
        "uncertain",
        `Uncertain outcome for ${row.id}; flagged for reconciliation`,
        row.id,
      );
      return;
    }
    // attempts already includes this claim (claim bumps exactly once),
    // so it is the current attempt number — no extra increment here.
    if (
      failureClass === "PERMANENT" ||
      failureClass === "ALREADY_COMPLETED" ||
      row.attempts >= deps.config.maxAttempts
    ) {
      const reason =
        failureClass === "ALREADY_COMPLETED"
          ? "already-completed"
          : failureClass === "PERMANENT"
            ? "permanent-failure"
            : "max-attempts";
      await withTransaction(async (client) => {
        await markTxDeadLetter(
          row.id,
          `${reason}: ${safeFailureMessage(outcome.error)}`,
          client,
        );
        await recordEvent(
          {
            type: "TRANSACTION_STATUS_CHANGED",
            agentId: row.agent_id,
            bondId: row.bond_id,
            txId: row.id,
            actor,
            payload: { transactionId: row.id, from: row.status, to: "FAILED" },
          },
          client,
        );
      });
      stats.deadLettered += 1;
      workerLogError("dead-letter", `Dead-lettered ${row.id}`, row.id);
      return;
    }
    const delay = computeBackoffDelayMs(
      Math.max(1, row.attempts),
      deps.config.backoffBaseMs,
      deps.config.backoffMaxMs,
      row.id,
    );
    await withTransaction(async (client) => {
      await scheduleTxRetry(
        row.id,
        addMsIso(clock(), delay),
        safeFailureMessage(outcome.error),
        client,
      );
      await recordEvent(
        {
          type: "TRANSACTION_STATUS_CHANGED",
          agentId: row.agent_id,
          bondId: row.bond_id,
          txId: row.id,
          actor,
          payload: {
            transactionId: row.id,
            from: row.status,
            to: row.status,
            note: `retry-scheduled:${delay}ms`,
          },
        },
        client,
      );
    });
    stats.retried += 1;
    workerLog("retry", `Retry scheduled for ${row.id} in ${delay}ms`, row.id);
  }

  async function confirmSweep(handle: ChainHandle | null): Promise<void> {
    const threshold = addMsIso(clock(), -deps.config.submittedReconcileAfterMs);
    const stuck = await findStuckSubmitted(threshold, deps.config.concurrency);
    stats.stuckSubmitted = stuck.length;
    // SIMULATED rows await explicit operator confirmation by design:
    // counted above, never touched here.
    if (!handle || handle.mode !== "REAL" || handle.providers === null) {
      return;
    }
    for (const row of stuck) {
      if (settling()) {
        break;
      }
      try {
        const updated = await confirmTransactionService(
          row.id,
          handle,
          actor,
          null,
        );
        if (updated.status === "CONFIRMED") {
          stats.confirmed += 1;
        }
      } catch (error) {
        stats.lastError = safeFailureMessage(error);
        workerLogError("confirm-sweep", `Confirm failed for ${row.id}`, row.id);
      }
    }
  }

  async function reconciliationSweep(
    handle: ChainHandle | null,
  ): Promise<void> {
    const flagged = await findReconciliationRequired(deps.config.concurrency);
    for (const row of flagged) {
      if (settling()) {
        break;
      }
      try {
        if (
          row.chain_tx_id &&
          handle &&
          handle.mode === "REAL" &&
          handle.providers !== null
        ) {
          const updated = await confirmTransactionService(
            row.id,
            handle,
            actor,
            null,
          );
          if (updated.status === "CONFIRMED" || updated.status === "FAILED") {
            await withTransaction(async (client) => {
              await clearReconciliationRequired(row.id, client);
            });
            stats.reconciled += 1;
            workerLog("reconciled", `Resolved ${row.id}`, row.id);
          }
        }
      } catch (error) {
        stats.lastError = safeFailureMessage(error);
        workerLogError(
          "reconcile-sweep",
          `Reconciliation failed for ${row.id}`,
          row.id,
        );
      }
    }
    // Phase 12: tx-row finality resolution. Any SUBMITTED row carrying a
    // chain reference is checked against authoritative finality and
    // resolved (CONFIRMED + mirrors, or FAILED) — idempotently, and
    // never by invention. Unknown/unreachable references are left for
    // the next pass.
    if (handle && handle.mode === "REAL" && handle.providers !== null) {
      try {
        const txReport = await reconcileTransactionRows(
          handle,
          deps.config.concurrency,
        );
        stats.reconciled += txReport.confirmed + txReport.failed;
        if (txReport.checked > 0) {
          workerLog(
            "reconcile-tx",
            `Tx rows checked=${txReport.checked} confirmed=${txReport.confirmed} failed=${txReport.failed} unknown=${txReport.unknownLeft}`,
          );
        }
      } catch (error) {
        stats.lastError = safeFailureMessage(error);
        workerLogError("reconcile-tx", "Transaction-row reconciliation failed");
      }
    }
  }

  async function maybeReconcile(handle: ChainHandle | null): Promise<void> {
    const now = clock();
    if (
      lastReconcileAt !== null &&
      Date.parse(now) - Date.parse(lastReconcileAt) <
        deps.config.reconcileIntervalMs
    ) {
      return;
    }
    lastReconcileAt = now;
    if (!handle || !deps.contractAddress) {
      return;
    }
    try {
      const report = await runReconciliationOnce(
        handle,
        deps.contractAddress,
        deps.config.reconcileBatchLimit,
      );
      stats.reconciled += report.healed;
      workerLog(
        "reconcile",
        `Reconciled checked=${report.checked} conflicts=${report.conflicts} healed=${report.healed}`,
      );
    } catch (error) {
      stats.lastError = safeFailureMessage(error);
      workerLogError("reconcile", "Periodic reconciliation failed");
    }
  }

  async function runOnce(): Promise<void> {
    if (settling()) {
      return;
    }
    stats.polls += 1;
    stats.lastPollAt = clock();
    const handle = deps.resolveHandle();
    try {
      const claimed = await claimJobs({
        workerId,
        leaseMs: deps.config.leaseMs,
        limit: deps.config.concurrency,
        nowIso: clock(),
      });
      for (const row of claimed) {
        if (settling()) {
          await withTransaction(async (client) => {
            await releaseTxClaim(row.id, client);
          });
          continue;
        }
        stats.claimed += 1;
        stats.activeJobs = active.size + 1;
        active.set(row.id, { txId: row.id, startedAt: clock() });
        try {
          if (!handle) {
            await withTransaction(async (client) => {
              await scheduleTxRetry(
                row.id,
                addMsIso(clock(), deps.config.pollIntervalMs),
                "no-chain-handle",
                client,
              );
            });
            continue;
          }
          const outcome = await executeSubmit(handle, row);
          await settleSubmit(row, outcome);
        } finally {
          active.delete(row.id);
          stats.activeJobs = active.size;
        }
      }
      await confirmSweep(handle);
      await reconciliationSweep(handle);
      await maybeReconcile(handle);
    } catch (error) {
      stats.lastError = safeFailureMessage(error);
      workerLogError("poll", `Worker poll failed: ${stats.lastError}`);
    }
  }

  async function loop(): Promise<void> {
    while (!stopped && !settling()) {
      await runOnce();
      if (stopped || settling()) {
        break;
      }
      await sleep(deps.config.pollIntervalMs);
    }
  }

  return {
    phase: () => phase,
    snapshot: () => ({
      enabled: deps.config.enabled,
      phase,
      workerId,
      stats: { ...stats },
    }),
    start: () => {
      if (!deps.config.enabled || looping) {
        return;
      }
      looping = true;
      phase = "RUNNING";
      workerLog("started", `Worker ${workerId} started`);
      void loop().finally(() => {
        looping = false;
      });
    },
    stop: async () => {
      stopped = true;
      if (phase === "RUNNING" || phase === "STARTING") {
        phase = "DRAINING";
      }
      workerLog("stopping", `Worker ${workerId} draining`);
      const deadline = Date.now() + deps.config.pollIntervalMs;
      while (active.size > 0 && Date.now() < deadline) {
        await sleep(25);
      }
      phase = "STOPPED";
      workerLog("stopped", `Worker ${workerId} stopped`);
    },
    runOnce,
  };
}
