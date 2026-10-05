import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  canTransitionTransaction,
  isConfirmedTransactionStatus,
  isTerminalTransactionStatus,
  transitionTransactionStatus,
} from "./transaction.js";
import type { TransactionStatus } from "./enums.js";

describe("transaction lifecycle", () => {
  it("walks IDLE → … → CONFIRMED", () => {
    const path: TransactionStatus[] = [
      "IDLE",
      "WALLET_APPROVAL",
      "PENDING",
      "SUBMITTED",
      "CONFIRMED",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionTransaction(path[i], path[i + 1])).toBe(true);
      expect(transitionTransactionStatus(path[i], path[i + 1])).toBe(
        path[i + 1],
      );
    }
    expect(isTerminalTransactionStatus("CONFIRMED")).toBe(true);
  });

  it("returns wallet rejection to draft without submission", () => {
    expect(transitionTransactionStatus("WALLET_APPROVAL", "IDLE")).toBe("IDLE");
  });

  it("fails from PENDING and SUBMITTED and retries with the same key", () => {
    expect(transitionTransactionStatus("PENDING", "FAILED")).toBe("FAILED");
    expect(transitionTransactionStatus("SUBMITTED", "FAILED")).toBe("FAILED");
    // Retry returns to draft; the caller reuses the idempotency key.
    expect(transitionTransactionStatus("FAILED", "IDLE")).toBe("IDLE");
  });

  it("gates successor actions on CONFIRMED only", () => {
    expect(isConfirmedTransactionStatus("CONFIRMED")).toBe(true);
    for (const s of [
      "IDLE",
      "WALLET_APPROVAL",
      "PENDING",
      "SUBMITTED",
      "FAILED",
    ] as TransactionStatus[]) {
      expect(isConfirmedTransactionStatus(s)).toBe(false);
    }
  });

  it("rejects invalid transitions", () => {
    const invalid: Array<[TransactionStatus, TransactionStatus]> = [
      ["IDLE", "SUBMITTED"],
      ["IDLE", "CONFIRMED"],
      ["WALLET_APPROVAL", "CONFIRMED"],
      ["PENDING", "CONFIRMED"],
      ["SUBMITTED", "IDLE"],
      ["CONFIRMED", "IDLE"],
      ["CONFIRMED", "FAILED"],
      ["FAILED", "CONFIRMED"],
    ];
    for (const [from, to] of invalid) {
      expect(canTransitionTransaction(from, to)).toBe(false);
      try {
        transitionTransactionStatus(from, to);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(
          "INVALID_TRANSACTION_TRANSITION",
        );
      }
    }
  });
});
