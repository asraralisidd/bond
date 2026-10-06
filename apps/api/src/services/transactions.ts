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
import type { PoolClient } from "pg";
import {
  parseTransactionId,
  transitionTransactionStatus,
} from "@bond/shared-types";
import type { TransactionPurpose, TransactionStatus } from "@bond/shared-types";
import type { ChainHandle, OperationResult } from "@bond/midnight-adapter";
import { confirmOperation } from "@bond/midnight-adapter";
import { withTransaction } from "../db/pool.js";
import {
  findChainTransactionById,
  findChainTransactionByIdForUpdate,
  findChainTransactionByIdempotencyKey,
  insertChainTransaction,
  listPendingChainTransactions,
  updateChainTransaction,
} from "../db/stores/chain.js";
import type { ChainTxRow } from "../db/stores/chain.js";
import { findAgentById, findBondById } from "../db/stores/registry.js";
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

/** Executor lookup for the worker submit path (SIMULATED registry). */
export function getPurposeExecutor(
  purpose: string,
): PurposeExecutor | undefined {
  return executors.get(purpose);
}

export type PurposeFinalizer = (
  row: ChainTxRow,
  client: PoolClient,
) => Promise<void>;

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
  // BOLA guard: a transaction intent may only reference the caller's own
  // agent/bond. Without this, any operator could plant intents (including
  // ENFORCEMENT) linked to another operator's resources.
  if (input.agentId !== undefined && input.agentId !== null) {
    const agent = await findAgentById(input.agentId);
    if (!agent) {
      throw new ApiError("NOT_FOUND", "Agent not found");
    }
    if (agent.operator_id !== input.operatorId) {
      throw new ApiError("FORBIDDEN", "Not your resource");
    }
  }
  if (input.bondId !== undefined && input.bondId !== null) {
    const bond = await findBondById(input.bondId);
    if (!bond) {
      throw new ApiError("NOT_FOUND", "Bond not found");
    }
    if (bond.operator_id !== input.operatorId) {
      throw new ApiError("FORBIDDEN", "Not your resource");
    }
  }
  const existing = await findChainTransactionByIdempotencyKey(
    input.idempotencyKey,
  );
  if (existing) {
    return { row: existing, created: false };
  }
  try {
    const row = await withTransaction(async (client) => {
      const created = await insertChainTransaction(
        {
          id: randomUUID(),
          purpose: input.purpose,
          agentId: input.agentId,
          bondId: input.bondId,
          idempotencyKey: input.idempotencyKey,
          status: "IDLE",
          nullifier: input.nullifier,
          params: input.params,
        },
        client,
      );
      await recordEvent(
        {
          type: "TRANSACTION_STATUS_CHANGED",
          agentId: input.agentId,
          bondId: input.bondId,
          txId: created.id,
          actor: `operator:${input.operatorId}`,
          requestId: input.requestId,
          payload: {
            transactionId: created.id,
            from: null,
            to: "IDLE",
            purpose: input.purpose,
          },
        },
        client,
      );
      return created;
    });
    return { row, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a concurrent insert race on idempotency_key: the winner's
      // row is the replay source. Never a duplicate action.
      const winner = await findChainTransactionByIdempotencyKey(
        input.idempotencyKey,
      );
      if (winner) {
        return { row: winner, created: false };
      }
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

export async function getTransactionService(id: string): Promise<ChainTxRow> {
  parseTransactionId(id);
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
  return withTransaction(async (client) => {
    const row = await findChainTransactionByIdForUpdate(id, client);
    if (!row) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    const next = transitionTransactionStatus(
      row.status as TransactionStatus,
      to,
    );
    await updateChainTransaction(id, { status: next }, client);
    await recordEvent(
      {
        type: "TRANSACTION_STATUS_CHANGED",
        agentId: row.agent_id,
        bondId: row.bond_id,
        txId: id,
        actor,
        requestId,
        payload: { transactionId: id, from: row.status, to: next },
      },
      client,
    );
    const updated = await findChainTransactionById(id, client);
    if (!updated) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    return updated;
  });
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
  await withTransaction(async (client) => {
    const fresh = await findChainTransactionByIdForUpdate(row.id, client);
    if (!fresh) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    const next = transitionTransactionStatus(
      fresh.status as TransactionStatus,
      to,
    );
    await updateChainTransaction(
      row.id,
      {
        status: next,
        chainTxId: extra?.chainTxId,
        lastError: extra?.error ?? null,
        confirmed: extra?.confirmed,
      },
      client,
    );
    await recordEvent(
      {
        type: "TRANSACTION_STATUS_CHANGED",
        agentId: fresh.agent_id,
        bondId: fresh.bond_id,
        txId: fresh.id,
        actor: "system:worker",
        payload: { transactionId: fresh.id, from: fresh.status, to: next },
      },
      client,
    );
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
 * Wallet-attended submission record (Phase 11).
 *
 * The operator's wallet submits through the connector; the API only
 * records the resulting chain reference on a PENDING intent owned by the
 * caller: PENDING → SUBMITTED with chainTxId. Confirmation still comes
 * exclusively from finality (confirmTransactionService / worker sweeps).
 * A client claim is never confirmation — chain state stays authoritative.
 */
export async function recordWalletSubmission(
  id: string,
  chainTxId: string,
  actor: string,
  requestId?: string | null,
): Promise<ChainTxRow> {
  return withTransaction(async (client) => {
    const row = await findChainTransactionByIdForUpdate(id, client);
    if (!row) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    // Conflicting chain reference always fails closed — even after
    // submission (a second, different reference means a forked reality).
    if (row.chain_tx_id && row.chain_tx_id !== chainTxId) {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        "Transaction already submitted with a different chain reference",
      );
    }
    if (row.status !== "PENDING") {
      throw new ApiError(
        "INVALID_TRANSACTION_TRANSITION",
        `Cannot record submission from ${row.status}`,
      );
    }
    const next = transitionTransactionStatus(
      row.status as TransactionStatus,
      "SUBMITTED",
    );
    await updateChainTransaction(id, { status: next, chainTxId }, client);
    await recordEvent(
      {
        type: "TRANSACTION_STATUS_CHANGED",
        agentId: row.agent_id,
        bondId: row.bond_id,
        txId: id,
        actor,
        requestId,
        payload: {
          transactionId: id,
          from: row.status,
          to: next,
          chainTxId,
        },
      },
      client,
    );
    const updated = await findChainTransactionById(id, client);
    if (!updated) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    return updated;
  });
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
  if (handle.mode === "SIMULATED") {
    return withTransaction(async (client) => {
      const row = await findChainTransactionByIdForUpdate(id, client);
      if (!row) {
        throw new ApiError("NOT_FOUND", "Transaction not found");
      }
      if (row.status !== "SUBMITTED") {
        throw new ApiError(
          "INVALID_TRANSACTION_TRANSITION",
          "Only SUBMITTED transactions can confirm",
        );
      }
      await updateChainTransaction(
        id,
        { status: "CONFIRMED", confirmed: true },
        client,
      );
      await recordEvent(
        {
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
        },
        client,
      );
      const finalizer = finalizers.get(row.purpose);
      if (finalizer) {
        const fresh = await findChainTransactionById(id, client);
        if (fresh) {
          await finalizer(fresh, client);
        }
      }
      const updated = await findChainTransactionById(id, client);
      if (!updated) {
        throw new ApiError("NOT_FOUND", "Transaction not found");
      }
      return updated;
    });
  }
  const row = await getTransactionService(id);
  if (row.status !== "SUBMITTED") {
    throw new ApiError(
      "INVALID_TRANSACTION_TRANSITION",
      "Only SUBMITTED transactions can confirm",
    );
  }
  if (!row.chain_tx_id) {
    throw new ApiError("INVALID_IDENTIFIER", "No chain reference to confirm");
  }
  // Network I/O happens OUTSIDE any database transaction: a hung prover
  // must never hold row locks or pool connections hostage.
  const result = await confirmOperation(handle, row.chain_tx_id);
  return withTransaction(async (client) => {
    const fresh = await findChainTransactionByIdForUpdate(id, client);
    if (!fresh) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    if (fresh.status === "CONFIRMED") {
      return fresh;
    }
    if (fresh.status !== "SUBMITTED") {
      throw new ApiError(
        "INVALID_TRANSACTION_TRANSITION",
        "Only SUBMITTED transactions can confirm",
      );
    }
    if (result.status === "CONFIRMED") {
      await updateChainTransaction(
        id,
        { status: "CONFIRMED", confirmed: true },
        client,
      );
      const finalizer = finalizers.get(fresh.purpose);
      if (finalizer) {
        const current = await findChainTransactionById(id, client);
        if (current) {
          await finalizer(current, client);
        }
      }
    } else {
      await updateChainTransaction(
        id,
        { status: "FAILED", lastError: "MIDNIGHT_CONFIRMATION_FAILED" },
        client,
      );
    }
    await recordEvent(
      {
        type: "TRANSACTION_STATUS_CHANGED",
        agentId: fresh.agent_id,
        bondId: fresh.bond_id,
        txId: id,
        actor,
        requestId,
        payload: {
          transactionId: id,
          from: fresh.status,
          to: result.status === "CONFIRMED" ? "CONFIRMED" : "FAILED",
        },
      },
      client,
    );
    const updated = await findChainTransactionById(id, client);
    if (!updated) {
      throw new ApiError("NOT_FOUND", "Transaction not found");
    }
    return updated;
  });
}
