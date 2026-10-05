/**
 * Shared contract test fixtures (not a test file).
 */
import { emptyLedger } from "./state.js";
import type { ContractLedger, OperatorCaller } from "./state.js";
import { CONTRACT_POLICY_VERSION, CONTRACT_VERSION } from "./versions.js";
import { flagAgent, lockBond, registerAgent } from "./entrypoints.js";

export const OPERATOR = "operator-001";
export const AGENT = "agent-001";
export const BOND = "bond-001";
export const OTHER_OPERATOR = "operator-999";
export const OTHER_AGENT = "agent-999";

export const NOW = "2026-10-02T00:00:00.000Z";
export const DECISION_EXPIRY = "2026-10-08T00:00:00.000Z";

export function operatorCaller(operatorId: string = OPERATOR): OperatorCaller {
  return { kind: "operator", operatorId };
}

export function freshLedger(): ContractLedger {
  return emptyLedger(CONTRACT_VERSION, CONTRACT_POLICY_VERSION);
}

/** Ledger with agent registered, bonded (10000), and flagged. */
export function flaggedLedger(): ContractLedger {
  let ledger = freshLedger();
  ledger = registerAgent(ledger, {
    agentId: AGENT,
    operatorId: OPERATOR,
    caller: operatorCaller(),
  });
  ledger = lockBond(ledger, {
    bondId: BOND,
    agentId: AGENT,
    operatorId: OPERATOR,
    commitmentMinorUnits: "10000",
    caller: operatorCaller(),
  });
  ledger = flagAgent(ledger, { agentId: AGENT, caller: operatorCaller() });
  return ledger;
}

export interface TestDecision {
  readonly decisionId: string;
  readonly action: "partial-slash" | "full-slash";
  readonly nullifier: string;
  readonly expiresAt: string;
  readonly agentId: string;
  readonly riskFlagId: string;
  readonly policyVersion: string;
  readonly amountMinorUnits?: string;
}

export function partialDecision(
  overrides?: Partial<TestDecision>,
): TestDecision {
  return {
    decisionId: "dec-001",
    action: "partial-slash",
    nullifier: "nullifier-001",
    expiresAt: DECISION_EXPIRY,
    agentId: AGENT,
    riskFlagId: "flag-001",
    policyVersion: CONTRACT_POLICY_VERSION,
    amountMinorUnits: "2500",
    ...overrides,
  };
}
