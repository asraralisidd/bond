import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  canTransitionBond,
  isTerminalBondStatus,
  transitionBondStatus,
} from "./bond.js";
import type { BondStatus } from "./enums.js";

describe("bond state machine", () => {
  it("walks the funding happy path to withdrawal", () => {
    const path: BondStatus[] = [
      "CREATED",
      "PENDING",
      "ACTIVE",
      "WITHDRAWABLE",
      "WITHDRAWN",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionBond(path[i], path[i + 1])).toBe(true);
      expect(transitionBondStatus(path[i], path[i + 1])).toBe(path[i + 1]);
    }
  });

  it("walks the lock round-trip", () => {
    expect(transitionBondStatus("ACTIVE", "LOCKED")).toBe("LOCKED");
    expect(transitionBondStatus("LOCKED", "ACTIVE")).toBe("ACTIVE");
  });

  it("walks partial then full slash enforcement", () => {
    expect(transitionBondStatus("ACTIVE", "PARTIALLY_SLASHED")).toBe(
      "PARTIALLY_SLASHED",
    );
    expect(transitionBondStatus("PARTIALLY_SLASHED", "WITHDRAWABLE")).toBe(
      "WITHDRAWABLE",
    );
    expect(transitionBondStatus("LOCKED", "FULLY_SLASHED")).toBe(
      "FULLY_SLASHED",
    );
  });

  it("supports failure and cancellation terminals", () => {
    expect(transitionBondStatus("PENDING", "FAILED")).toBe("FAILED");
    expect(transitionBondStatus("CREATED", "CANCELLED")).toBe("CANCELLED");
    expect(transitionBondStatus("PENDING", "CANCELLED")).toBe("CANCELLED");
    for (const terminal of [
      "WITHDRAWN",
      "FAILED",
      "CANCELLED",
      "FULLY_SLASHED",
    ] as BondStatus[]) {
      expect(isTerminalBondStatus(terminal)).toBe(true);
    }
    expect(isTerminalBondStatus("ACTIVE")).toBe(false);
  });

  it("rejects invalid transitions with structured errors", () => {
    const invalid: Array<[BondStatus, BondStatus]> = [
      ["PENDING", "WITHDRAWABLE"],
      ["PENDING", "WITHDRAWN"],
      ["FAILED", "CREATED"],
      ["FAILED", "PENDING"],
      ["WITHDRAWN", "ACTIVE"],
      ["WITHDRAWN", "WITHDRAWABLE"],
      ["CANCELLED", "PENDING"],
      ["CREATED", "ACTIVE"],
      ["WITHDRAWABLE", "ACTIVE"],
      ["FULLY_SLASHED", "WITHDRAWABLE"],
      ["PARTIALLY_SLASHED", "ACTIVE"],
    ];
    for (const [from, to] of invalid) {
      expect(canTransitionBond(from, to)).toBe(false);
      try {
        transitionBondStatus(from, to);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("INVALID_BOND_TRANSITION");
        expect((error as DomainError).details).toMatchObject({ from, to });
      }
    }
  });

  it("is deterministic", () => {
    expect(transitionBondStatus("CREATED", "PENDING")).toBe(
      transitionBondStatus("CREATED", "PENDING"),
    );
  });
});
