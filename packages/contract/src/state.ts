/**
 * Authoritative contract state model (minimal, fail-closed).
 *
 * This is the normative rule model that future Compact circuits must
 * implement 1:1. It is PURE domain logic: no chain, no wallet, no crypto,
 * no network. Amounts are opaque digit strings (integer-safe, no floats);
 * arithmetic uses BigInt internally and never leaves as float.
 *
 * Agent-state mapping from Phase 1 (documented, no competing lifecycle):
 * - UNREGISTERED → absence from the ledger (no record, no transitions).
 * - ATTESTED → lives on the decision record only (Phase 1 resolution).
 * - SUSPENDED → off-chain only (Phase 0 doc 03/04: enforced off-chain).
 * - WITHDRAWABLE → bond-level state, mirrored here via the linked bond.
 * - PENDING/CREATED/FAILED (bond) → off-chain mirror states; the contract
 *   records a bond only once its lock is confirmed (ACTIVE).
 */
import type { CONTRACT_POLICY_VERSION, CONTRACT_VERSION } from "./versions.js";

export type ContractAgentStatus =
  "REGISTERED" | "BONDED" | "ACTIVE" | "FLAGGED" | "SLASHED" | "RESOLVED";

export type ContractBondStatus =
  | "ACTIVE"
  | "LOCKED"
  | "PARTIALLY_SLASHED"
  | "FULLY_SLASHED"
  | "WITHDRAWABLE"
  | "WITHDRAWN"
  | "CANCELLED";

/** Operator-authorized call (maps to wallet-signature checks on-chain). */
export interface OperatorCaller {
  readonly kind: "operator";
  readonly operatorId: string;
}

/**
 * Enforcement call carrying its authorizing decision reference.
 * Maps to quorum-signature verification on-chain. The Risk Engine has no
 * caller form here by design: there is no path from risk output to this
 * interface except through an attested decision.
 */
export interface EnforcementCaller {
  readonly kind: "enforcement";
  readonly decisionId: string;
}

export type ContractCaller = OperatorCaller | EnforcementCaller;

export interface ContractAgentState {
  readonly agentId: string;
  readonly operatorId: string;
  readonly status: ContractAgentStatus;
  readonly bondId: string | null;
  readonly slashCount: number;
  readonly policyVersion: typeof CONTRACT_POLICY_VERSION;
}

export interface ContractBondState {
  readonly bondId: string;
  readonly agentId: string;
  readonly operatorId: string;
  /** PRIVATE. Opaque minor-unit digit string. Never in public views. */
  readonly commitmentMinorUnits: string;
  /** PRIVATE. Running total slashed, same representation. */
  readonly slashedTotalMinorUnits: string;
  readonly status: ContractBondStatus;
  readonly policyVersion: typeof CONTRACT_POLICY_VERSION;
  readonly withdrawalConsumed: boolean;
}

export interface ContractLedger {
  readonly agents: Readonly<Record<string, ContractAgentState>>;
  readonly bonds: Readonly<Record<string, ContractBondState>>;
  /** Consumed enforcement nullifiers (opaque strings, replay protection). */
  readonly consumedEnforcementNullifiers: readonly string[];
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly policyVersion: typeof CONTRACT_POLICY_VERSION;
}

export function emptyLedger(
  contractVersion: typeof CONTRACT_VERSION,
  policyVersion: typeof CONTRACT_POLICY_VERSION,
): ContractLedger {
  return {
    agents: {},
    bonds: {},
    consumedEnforcementNullifiers: [],
    contractVersion,
    policyVersion,
  };
}
