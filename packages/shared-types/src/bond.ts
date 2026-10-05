/**
 * Bond domain: collateral lifecycle state machine.
 *
 * Terminology and transitions follow Phase 0 doc 04 verbatim. Two
 * smallest-safe clarifications (documented in docs/phase-1):
 * - PENDING → CANCELLED is allowed ("cancelled before activation").
 * - ACTIVE | LOCKED → FULLY_SLASHED is allowed (single enforcement can
 *   exhaust collateral; Phase 0's "… → FULLY_SLASHED" implies this).
 * No return from PARTIALLY_SLASHED to ACTIVE: remainder stays locked
 * until release or further enforcement.
 */
import { DomainError } from "./errors.js";
import type { AgentId, BondId, OperatorId } from "./ids.js";
import type { BondStatus } from "./enums.js";

/**
 * Collateral commitment. `amountMinorUnits` is an opaque decimal string
 * (no floats) and is PRIVATE — it must only cross into public views
 * through the projection layer (see projections.ts).
 */
export interface BondCommitment {
  readonly amountMinorUnits: string;
  readonly denomination: string;
}

export interface Bond {
  readonly bondId: BondId;
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  readonly commitment: BondCommitment;
  readonly policyVersion: string;
  readonly status: BondStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type BondTransitionMap = Readonly<Record<BondStatus, readonly BondStatus[]>>;

const BOND_TRANSITIONS: BondTransitionMap = {
  CREATED: ["PENDING", "CANCELLED"],
  PENDING: ["ACTIVE", "FAILED", "CANCELLED"],
  ACTIVE: ["LOCKED", "PARTIALLY_SLASHED", "FULLY_SLASHED", "WITHDRAWABLE"],
  LOCKED: ["ACTIVE", "PARTIALLY_SLASHED", "FULLY_SLASHED"],
  PARTIALLY_SLASHED: ["FULLY_SLASHED", "WITHDRAWABLE"],
  FULLY_SLASHED: [],
  WITHDRAWABLE: ["WITHDRAWN"],
  WITHDRAWN: [],
  FAILED: [],
  CANCELLED: [],
};

export function isBondStatus(value: unknown): value is BondStatus {
  return (
    typeof value === "string" &&
    (Object.keys(BOND_TRANSITIONS) as BondStatus[]).includes(
      value as BondStatus,
    )
  );
}

export function canTransitionBond(from: BondStatus, to: BondStatus): boolean {
  return BOND_TRANSITIONS[from].includes(to);
}

/**
 * Deterministic bond transition. Returns the target status when valid;
 * throws INVALID_BOND_TRANSITION otherwise. Pure function.
 */
export function transitionBondStatus(
  from: BondStatus,
  to: BondStatus,
): BondStatus {
  if (!canTransitionBond(from, to)) {
    throw new DomainError(
      "INVALID_BOND_TRANSITION",
      `Invalid bond transition: ${from} → ${to}`,
      { from, to },
    );
  }
  return to;
}

/** Bond states with no outgoing transitions. */
export function isTerminalBondStatus(status: BondStatus): boolean {
  return BOND_TRANSITIONS[status].length === 0;
}
