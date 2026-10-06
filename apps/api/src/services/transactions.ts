/**
 * Transaction tracking service + worker.
 *
 * Lifecycle (Phase 1 machine): IDLE → WALLET_APPROVAL → PENDING →
 * SUBMITTED → CONFIRMED / FAILED. The API NEVER reports CONFIRMED
 * without finality: SIMULATED receipts stop at SUBMITTED/FAILED, and
 * SIMULATED confirmation requires an explicit operator confirm action
 * (dev-only, auditable — never automatic). REAL confirmation comes only
 * from adapter finality checks.
 *
 * Purpose executors are registered per domain area (bonds, enforcement,
 * …) so this module never imports risk/attestor specifics directly.
 */
import { randomUUID } from "node:crypto";
import { transitionTransactionStatus } from "@bond/shared-types";
import type { TransactionPurpose, TransactionStatus } from "@bond/shared-types";
import type { ChainHandle, OperationResult } from "@bond/midnight-adapter";
import { confirmOperation } from "@bond/midnight-adapter";
import {
  findChainTransactionById,
  findChainTransactionByIdempotencyKey,
  insertChainTransaction,
  listPendingChainTransactions,
  updateChainTransaction,
} from "../db/stores/chain.js";
import type { ChainTxRow } from "../db/stores/chain.js";
import { ApiError } from "../http/errors.js";
import { recordEvent } from "./events.js";

const VALID_PURPOSES: ReadonlySet<string> = new Set([
  "FUND_BOND",
  "RELEASE_BOND",
  "WITHDRAW",
  "ENFORCEMENT",
  "REGISTRATION_ANCHOR",
]);

export type PurposeExecutor = (
  handle: ChainHandle,
  row: ChainTxRow,
) => Promise<OperationResult>;

const executors = new Map<string, PurposeExecutor>();

export function registerPurposeExecutor(
  purpose: TransactionPurpose,
  executor: PurposeExecutor,
): void {
  executors.set(purpose, executor);
}

export type PurposeFinalizer = (row: ChainTxRow) => Promise<void>;

const finalizers = new Map<string, PurposeFinalizer>();

export function registerPurposeFinalizer(
  purpose: TransactionPurpose,
  finalizer: PurposeFinalizer,
): void {
  finalizers.set(purpose, finalizer);
}

export async function createTransactionIntent(input: {
  readonly operatorId: string;
  readonly purpose: TransactionPurpose;
  readonly agentId?: string | null;
  readonly bondId?: string | null;
  readonly idempotencyKey: string;
  readonly nullifier?: string | null;
  readonly params?: unknown;
  readonly requestId?: string | null;
}): Promise<{ row: ChainTxRow; created: boolean }> {
  if (!VALID_PURPOSES.has(input.purpose)) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid transaction purpose");
  }
  const existing = await findChainTransactionByIdempotencyKey(
    input.idempotencyKey,
  );
  if (existing) {
    return { row: existing, created: false };
  }
  const row = await insertChainTransaction({
    id: randomUUID(),
    purpose: input.purpose,
    agentId: input.agentId,
    bondId: input.bondId,
    idempotencyKey: input.idempotencyKey,
    status: "IDLE",
    nullifier: input.nullifier,
    params: input.params,
  });
  await recordEvent({
    type: "TRANSACTION_STATUS_CHANGED",
    agentId: input.agentId,
    bondId: input.bondId,
    txId: row.id,
    actor: `operator:${input.operatorId}`,
    requestId: input.requestId,
    payload: {
      transactionId: row.id,
      from: null,
      to: "IDLE",
      purpose: input.purpose,
    },
  });
  return { row, created: true };
}

export async function getTransactionService(id: string): Promise<ChainTxRow> {
  const row = await findChainTransactionById(id);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Transaction not found");
  }
  return row;
}

export async function advanceTransactionService(
  id: string,
  to: TransactionStatus,
  actor: string,
  requestId?: string | null,
): Promise<ChainTxRow> {
  const row = await getTransactionService(id);
  const next = transitionTransactionStatus(row.status as TransactionStatus, to);
  await updateChainTransaction(id, { status: next });
  await recordEvent({
    type: "TRANSACTION_STATUS_CHANGED",
    agentId: row.agent_id,
    bondId: row.bond_id,
    txId: id,
    actor,
    requestId,
    payload: { transactionId: id, from: row.status, to: next },
  });
  const updated = await getTransactionService(id);
  return updated;
}

async function setTxStatus(
  row: ChainTxRow,
  to: TransactionStatus,
  extra?: {
    chainTxId?: string | null;
    error?: string | null;
    confirmed?: boolean;
  },
): Promise<void> {
  const next = transitionTransactionStatus(row.status as TransactionStatus, to);
  await updateChainTransaction(row.id, {
    status: next,
    chainTxId: extra?.chainTxId,
    lastError: extra?.error ?? null,
    confirmed: extra?.confirmed,
  });
  await recordEvent({
    type: "TRANSACTION_STATUS_CHANGED",
    agentId: row.agent_id,
    bondId: row.bond_id,
    txId: row.id,
    actor: "system:worker",
    payload: { transactionId: row.id, from: row.status, to: next },
  });
}

/**
 * Single worker pass over PENDING rows. SIMULATED handles execute the
 * registered purpose executor; REAL handles are skipped here (submission
 * with a wallet happens in the request path, confirmation via
 * confirmTransactionService). Never marks CONFIRMED.
 */
export async function runTransactionWorkerOnce(
  handle: ChainHandle,
): Promise<{ processed: number; submitted: number; failed: number }> {
  let processed = 0;
  let submitted = 0;
  let failed = 0;
  const pending = await listPendingChainTransactions(25);
  for (const row of pending) {
    processed += 1;
    if (handle.mode !== "SIMULATED") {
      continue;
    }
    const executor = executors.get(row.purpose);
    if (!executor) {
      await setTxStatus(row, "FAILED", {
        error: `No executor for purpose ${row.purpose}`,
      });
      failed += 1;
      continue;
    }
    try {
      const result = await executor(handle, row);
      if (result.status === "SUBMITTED") {
        await setTxStatus(row, "SUBMITTED", { chainTxId: result.txId });
        submitted += 1;
      } else {
        await setTxStatus(row, "FAILED", {
          error: result.errorCode ?? "SIMULATED_FAILURE",
        });
        failed += 1;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
      await setTxStatus(row, "FAILED", { error: message });
      failed += 1;
    }
  }
  return { processed, submitted, failed };
}

/**
 * Explicit confirmation step. SIMULATED: operator-driven dev confirm
 * (auditable, never automatic). REAL: adapter finality check only.
 */
export async function confirmTransactionService(
  id: string,
  handle: ChainHandle,
  actor: string,
  requestId?: string | null,
): Promise<ChainTxRow> {
  const row = await getTransactionService(id);
  if (row.status !== "SUBMITTED") {
    throw new ApiError(
      "INVALID_TRANSACTION_TRANSITION",
      "Only SUBMITTED transactions can confirm",
    );
  }
  if (handle.mode === "SIMULATED") {
    await setTxStatus(row, "CONFIRMED", { confirmed: true });
    await recordEvent({
      type: "TRANSACTION_STATUS_CHANGED",
      agentId: row.agent_id,
      bondId: row.bond_id,
      txId: id,
      actor,
      requestId,
      payload: {
        transactionId: id,
        from: "SUBMITTED",
        to: "CONFIRMED",
        mode: "SIMULATED",
      },
    });
    const finalizer = finalizers.get(row.purpose);
    if (finalizer) {
      await finalizer(await getTransactionService(id));
    }
    return getTransactionService(id);
  }
  if (!row.chain_tx_id) {
    throw new ApiError("INVALID_IDENTIFIER", "No chain reference to confirm");
  }
  const result = await confirmOperation(handle, row.chain_tx_id);
  if (result.status === "CONFIRMED") {
    await setTxStatus(row, "CONFIRMED", { confirmed: true });
    const finalizer = finalizers.get(row.purpose);
    if (finalizer) {
      await finalizer(await getTransactionService(id));
    }
  } else {
    await setTxStatus(row, "FAILED", { error: "MIDNIGHT_CONFIRMATION_FAILED" });
  }
  return getTransactionService(id);
}
