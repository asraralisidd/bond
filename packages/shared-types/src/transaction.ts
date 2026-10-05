/**
 * Transaction domain: chain-operation lifecycle as a pure state machine.
 *
 * Phase 0 doc 11 §11.2 states, domain only. Nothing here touches a wallet
 * or a chain: it records intent → approval → submission → outcome so later
 * phases can reconcile against real transaction state.
 */
import { DomainError } from "./errors.js";
import type { AgentId, BondId, TransactionId } from "./ids.js";
import type { TransactionPurpose, TransactionStatus } from "./enums.js";

export interface TransactionRecord {
  readonly transactionId: TransactionId;
  readonly agentId: AgentId | null;
  readonly bondId: BondId | null;
  readonly purpose: TransactionPurpose;
  /** Client-supplied idempotency key (Phase 0 doc 10). */
  readonly idempotencyKey: string;
  readonly status: TransactionStatus;
  /** Chain reference. Null until SUBMITTED — never optimistically set. */
  readonly chainRef: string | null;
  /** Nullifier consumed by this transaction, if any (Phase 0 doc 08). */
  readonly nullifier: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type TransactionTransitionMap = Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
>;

const TRANSACTION_TRANSITIONS: TransactionTransitionMap = {
  // Draft: nothing submitted.
  IDLE: ["WALLET_APPROVAL"],
  // Wallet rejected/disconnected → back to draft; approved → pending.
  WALLET_APPROVAL: ["PENDING", "IDLE"],
  PENDING: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
  // Terminal success.
  CONFIRMED: [],
  // Retry reuses the same idempotency key (no duplicate submission).
  FAILED: ["IDLE"],
};

export function canTransitionTransaction(
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

/**
 * Deterministic transaction transition. Pure function; throws
 * INVALID_TRANSACTION_TRANSITION on invalid moves.
 */
export function transitionTransactionStatus(
  from: TransactionStatus,
  to: TransactionStatus,
): TransactionStatus {
  if (!canTransitionTransaction(from, to)) {
    throw new DomainError(
      "INVALID_TRANSACTION_TRANSITION",
      `Invalid transaction transition: ${from} → ${to}`,
      { from, to },
    );
  }
  return to;
}

export function isTerminalTransactionStatus(
  status: TransactionStatus,
): boolean {
  return TRANSACTION_TRANSITIONS[status].length === 0;
}

/** Only CONFIRMED may unlock successor actions (Phase 0 doc 11 rule 2). */
export function isConfirmedTransactionStatus(
  status: TransactionStatus,
): boolean {
  return status === "CONFIRMED";
}
