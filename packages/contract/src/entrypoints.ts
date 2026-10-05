/**
 * Contract entrypoints: the smallest safe operation set.
 *
 * Every entrypoint is a pure function (ledger in → ledger + receipt out)
 * with explicit, ordered, fail-closed guards: caller authorization first,
 * then subject/binding validation, then state validation, then replay
 * protection, then the deterministic transition. No silent corrections,
 * no implicit resets, no backwards moves.
 *
 * Entrypoints: registerAgent, lockBond, activateAgent, flagAgent,
 * resolveAgent, processEnforcement, releaseBond, withdrawBond.
 */
import { DomainError } from "@bond/shared-types";
import type { DomainErrorCode } from "@bond/shared-types";
import { CONTRACT_POLICY_VERSION } from "./versions.js";
import type {
  ContractAgentState,
  ContractBondState,
  ContractCaller,
  ContractLedger,
} from "./state.js";

export interface EnforcementDecisionInput {
  readonly decisionId: string;
  readonly action: "partial-slash" | "full-slash";
  readonly nullifier: string;
  readonly expiresAt: string;
  readonly agentId: string;
  readonly riskFlagId: string;
  readonly policyVersion: string;
  /**
   * Required for partial-slash (Phase 1 decisions carry no amount; the
   * adapter request supplies it and the contract validates it).
   * Forbidden for full-slash (remainder is consumed by definition).
   */
  readonly amountMinorUnits?: string;
}

export interface SlashReceipt {
  readonly bondId: string;
  readonly agentId: string;
  readonly decisionId: string;
  readonly riskFlagId: string;
  /** PRIVATE amount. Receipts are internal; public views use bands. */
  readonly slashedMinorUnits: string;
  readonly isFullSlash: boolean;
  readonly nullifier: string;
}

function fail(
  code: DomainErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>>,
): never {
  throw new DomainError(code, message, details);
}

function requireOperator(
  caller: ContractCaller,
  operatorId: string,
  operation: string,
): void {
  if (caller.kind !== "operator" || caller.operatorId !== operatorId) {
    fail("INVALID_IDENTIFIER", `Unauthorized ${operation}: operator only`, {
      operation,
    });
  }
}

function requireDigits(value: string, field: string): void {
  if (!/^[0-9]+$/.test(value)) {
    fail("INVALID_IDENTIFIER", `Invalid ${field}: digits only`, { field });
  }
}

function getAgent(ledger: ContractLedger, agentId: string): ContractAgentState {
  const agent = ledger.agents[agentId];
  if (agent === undefined) {
    fail("INVALID_AGENT_TRANSITION", "Unknown agent", { agentId });
  }
  return agent as ContractAgentState;
}

function getBond(ledger: ContractLedger, bondId: string): ContractBondState {
  const bond = ledger.bonds[bondId];
  if (bond === undefined) {
    fail("INVALID_BOND_TRANSITION", "Unknown bond", { bondId });
  }
  return bond as ContractBondState;
}

function setAgent(
  ledger: ContractLedger,
  agent: ContractAgentState,
): ContractLedger {
  return {
    ...ledger,
    agents: { ...ledger.agents, [agent.agentId]: agent },
  };
}

function setBond(
  ledger: ContractLedger,
  bond: ContractBondState,
): ContractLedger {
  return {
    ...ledger,
    bonds: { ...ledger.bonds, [bond.bondId]: bond },
  };
}

/** REGISTER AGENT: establishes identity + operator; rejects duplicates. */
export function registerAgent(
  ledger: ContractLedger,
  input: {
    readonly agentId: string;
    readonly operatorId: string;
    readonly caller: ContractCaller;
  },
): ContractLedger {
  requireOperator(input.caller, input.operatorId, "register-agent");
  if (input.agentId.length === 0 || input.operatorId.length === 0) {
    fail("INVALID_IDENTIFIER", "agentId/operatorId required", {});
  }
  if (ledger.agents[input.agentId] !== undefined) {
    fail("INVALID_AGENT_TRANSITION", "Duplicate agent registration", {
      agentId: input.agentId,
    });
  }
  return setAgent(ledger, {
    agentId: input.agentId,
    operatorId: input.operatorId,
    status: "REGISTERED",
    bondId: null,
    slashCount: 0,
    policyVersion: CONTRACT_POLICY_VERSION,
  });
}

/** CREATE/LOCK BOND: confirmed lock only (no fake transfers, no PENDING here). */
export function lockBond(
  ledger: ContractLedger,
  input: {
    readonly bondId: string;
    readonly agentId: string;
    readonly operatorId: string;
    readonly commitmentMinorUnits: string;
    readonly caller: ContractCaller;
  },
): ContractLedger {
  const agent = getAgent(ledger, input.agentId);
  requireOperator(input.caller, agent.operatorId, "lock-bond");
  if (
    input.caller.kind !== "operator" ||
    input.caller.operatorId !== input.operatorId
  ) {
    fail("INVALID_IDENTIFIER", "Bond operator must match caller", {});
  }
  if (agent.status !== "REGISTERED") {
    fail("INVALID_AGENT_TRANSITION", "Bond requires a REGISTERED agent", {
      agentId: agent.agentId,
      status: agent.status,
    });
  }
  if (agent.bondId !== null) {
    fail("INVALID_BOND_TRANSITION", "Agent already has an active bond", {
      agentId: agent.agentId,
    });
  }
  if (ledger.bonds[input.bondId] !== undefined) {
    fail("INVALID_BOND_TRANSITION", "Duplicate bond id", {
      bondId: input.bondId,
    });
  }
  requireDigits(input.commitmentMinorUnits, "commitmentMinorUnits");
  if (BigInt(input.commitmentMinorUnits) <= 0n) {
    fail("INVALID_BOND_TRANSITION", "Bond commitment must be positive", {});
  }
  const withBond = setBond(ledger, {
    bondId: input.bondId,
    agentId: agent.agentId,
    operatorId: agent.operatorId,
    commitmentMinorUnits: input.commitmentMinorUnits,
    slashedTotalMinorUnits: "0",
    status: "ACTIVE",
    policyVersion: CONTRACT_POLICY_VERSION,
    withdrawalConsumed: false,
  });
  return setAgent(withBond, {
    ...agent,
    status: "BONDED",
    bondId: input.bondId,
  });
}

/** Operator marks a bonded agent in service. */
export function activateAgent(
  ledger: ContractLedger,
  input: { readonly agentId: string; readonly caller: ContractCaller },
): ContractLedger {
  const agent = getAgent(ledger, input.agentId);
  requireOperator(input.caller, agent.operatorId, "activate-agent");
  if (agent.status !== "BONDED") {
    fail("INVALID_AGENT_TRANSITION", "Only BONDED agents activate", {
      status: agent.status,
    });
  }
  return setAgent(ledger, { ...agent, status: "ACTIVE" });
}

/** Operator acknowledges review: BONDED/ACTIVE → FLAGGED. */
export function flagAgent(
  ledger: ContractLedger,
  input: { readonly agentId: string; readonly caller: ContractCaller },
): ContractLedger {
  const agent = getAgent(ledger, input.agentId);
  requireOperator(input.caller, agent.operatorId, "flag-agent");
  if (agent.status !== "BONDED" && agent.status !== "ACTIVE") {
    fail("INVALID_AGENT_TRANSITION", "Only BONDED/ACTIVE agents flag", {
      status: agent.status,
    });
  }
  return setAgent(ledger, { ...agent, status: "FLAGGED" });
}

/** Close an incident: FLAGGED/SLASHED → RESOLVED (operator). */
export function resolveAgent(
  ledger: ContractLedger,
  input: { readonly agentId: string; readonly caller: ContractCaller },
): ContractLedger {
  const agent = getAgent(ledger, input.agentId);
  requireOperator(input.caller, agent.operatorId, "resolve-agent");
  if (agent.status !== "FLAGGED" && agent.status !== "SLASHED") {
    fail("INVALID_AGENT_TRANSITION", "Only FLAGGED/SLASHED resolve", {
      status: agent.status,
    });
  }
  return setAgent(ledger, { ...agent, status: "RESOLVED" });
}

/**
 * Return a resolved agent to service: RESOLVED → ACTIVE (operator).
 * Requires the linked bond to still hold slashable value; a fully
 * slashed, withdrawn, or cancelled bond cannot back reactivation.
 */
export function reactivateAgent(
  ledger: ContractLedger,
  input: { readonly agentId: string; readonly caller: ContractCaller },
): ContractLedger {
  const agent = getAgent(ledger, input.agentId);
  requireOperator(input.caller, agent.operatorId, "reactivate-agent");
  if (agent.status !== "RESOLVED") {
    fail("INVALID_AGENT_TRANSITION", "Only RESOLVED agents reactivate", {
      status: agent.status,
    });
  }
  if (agent.bondId === null) {
    fail("INVALID_BOND_TRANSITION", "Reactivation requires a bond", {});
  }
  const bond = getBond(ledger, agent.bondId);
  if (bond.status !== "ACTIVE" && bond.status !== "PARTIALLY_SLASHED") {
    fail("INVALID_BOND_TRANSITION", "Bond cannot back reactivation", {
      status: bond.status,
    });
  }
  return setAgent(ledger, { ...agent, status: "ACTIVE" });
}

/**
 * PROCESS ENFORCEMENT: the only path that moves bonded value.
 * Guards (fail-closed order): enforcement caller → known bond/agent →
 * subject binding → policy version → freshness → replay → flagged agent →
 * slashable bond → amount validity → deterministic application.
 */
export function processEnforcement(
  ledger: ContractLedger,
  input: {
    readonly bondId: string;
    readonly decision: EnforcementDecisionInput;
    readonly caller: ContractCaller;
    readonly nowIso: string;
  },
): { readonly ledger: ContractLedger; readonly receipt: SlashReceipt } {
  if (input.caller.kind !== "enforcement") {
    fail(
      "INVALID_IDENTIFIER",
      "Enforcement requires an enforcement caller",
      {},
    );
  }
  const bond = getBond(ledger, input.bondId);
  const agent = getAgent(ledger, bond.agentId);
  const { decision } = input;
  if (decision.agentId !== agent.agentId || decision.agentId !== bond.agentId) {
    fail("INVALID_ATTESTATION", "Decision/agent/bond subject mismatch", {
      decisionAgent: decision.agentId,
      agentId: agent.agentId,
    });
  }
  if (decision.policyVersion !== ledger.policyVersion) {
    fail("INVALID_ATTESTATION", "Decision policy version mismatch", {
      decision: decision.policyVersion,
      ledger: ledger.policyVersion,
    });
  }
  if (
    Number.isNaN(Date.parse(decision.expiresAt)) ||
    Number.isNaN(Date.parse(input.nowIso))
  ) {
    fail("INVALID_ATTESTATION", "Invalid timestamp", {});
  }
  if (decision.nullifier.length === 0) {
    fail("INVALID_ATTESTATION", "Decision nullifier required", {});
  }
  // Replay dominates expiry and state: a consumed request was already
  // processed even if the decision later expired or the agent moved on
  // (e.g. no longer FLAGGED after the first slash).
  if (ledger.consumedEnforcementNullifiers.includes(decision.nullifier)) {
    fail("REPLAYED_ATTESTATION", "Enforcement request already processed", {
      nullifier: decision.nullifier,
    });
  }
  if (Date.parse(input.nowIso) >= Date.parse(decision.expiresAt)) {
    fail("EXPIRED_ATTESTATION", "Enforcement decision expired", {
      decisionId: decision.decisionId,
    });
  }
  if (agent.status !== "FLAGGED") {
    fail("INVALID_AGENT_TRANSITION", "Enforcement requires a FLAGGED agent", {
      status: agent.status,
    });
  }
  if (
    bond.status !== "ACTIVE" &&
    bond.status !== "LOCKED" &&
    bond.status !== "PARTIALLY_SLASHED"
  ) {
    fail("INVALID_BOND_TRANSITION", "Bond not slashable in its state", {
      status: bond.status,
    });
  }
  const remaining =
    BigInt(bond.commitmentMinorUnits) - BigInt(bond.slashedTotalMinorUnits);
  if (remaining <= 0n) {
    fail("INVALID_BOND_TRANSITION", "Nothing left to slash", {});
  }
  let slashAmount: bigint;
  let isFullSlash: boolean;
  if (decision.action === "full-slash") {
    if (decision.amountMinorUnits !== undefined) {
      fail("INVALID_ATTESTATION", "full-slash takes no amount", {});
    }
    slashAmount = remaining;
    isFullSlash = true;
  } else {
    if (decision.amountMinorUnits === undefined) {
      fail("INVALID_ATTESTATION", "partial-slash requires an amount", {});
    }
    requireDigits(decision.amountMinorUnits, "amountMinorUnits");
    slashAmount = BigInt(decision.amountMinorUnits);
    if (slashAmount <= 0n || slashAmount > remaining) {
      fail("INVALID_ATTESTATION", "Slash amount out of range", {});
    }
    isFullSlash = slashAmount === remaining;
  }
  const slashedTotal = BigInt(bond.slashedTotalMinorUnits) + slashAmount;
  const bondStatus =
    slashedTotal >= BigInt(bond.commitmentMinorUnits)
      ? "FULLY_SLASHED"
      : "PARTIALLY_SLASHED";
  const withBond = setBond(ledger, {
    ...bond,
    slashedTotalMinorUnits: slashedTotal.toString(),
    status: bondStatus,
  });
  const withAgent = setAgent(withBond, {
    ...agent,
    status: "SLASHED",
    slashCount: agent.slashCount + 1,
  });
  const next: ContractLedger = {
    ...withAgent,
    consumedEnforcementNullifiers: [
      ...withAgent.consumedEnforcementNullifiers,
      decision.nullifier,
    ],
  };
  return {
    ledger: next,
    receipt: {
      bondId: bond.bondId,
      agentId: agent.agentId,
      decisionId: decision.decisionId,
      riskFlagId: decision.riskFlagId,
      slashedMinorUnits: slashAmount.toString(),
      isFullSlash,
      nullifier: decision.nullifier,
    },
  };
}

/** Release locked remainder toward withdrawal (operator, never while flagged). */
export function releaseBond(
  ledger: ContractLedger,
  input: { readonly bondId: string; readonly caller: ContractCaller },
): ContractLedger {
  const bond = getBond(ledger, input.bondId);
  const agent = getAgent(ledger, bond.agentId);
  requireOperator(input.caller, bond.operatorId, "release-bond");
  if (bond.status !== "ACTIVE" && bond.status !== "PARTIALLY_SLASHED") {
    fail("INVALID_BOND_TRANSITION", "Bond not releasable in its state", {
      status: bond.status,
    });
  }
  if (agent.status === "FLAGGED") {
    fail("INVALID_AGENT_TRANSITION", "Cannot release while agent flagged", {});
  }
  return setBond(ledger, { ...bond, status: "WITHDRAWABLE" });
}

/** Withdraw released funds exactly once (operator, single-use). */
export function withdrawBond(
  ledger: ContractLedger,
  input: { readonly bondId: string; readonly caller: ContractCaller },
): ContractLedger {
  const bond = getBond(ledger, input.bondId);
  requireOperator(input.caller, bond.operatorId, "withdraw-bond");
  if (bond.status !== "WITHDRAWABLE") {
    fail("INVALID_BOND_TRANSITION", "Bond not withdrawable", {
      status: bond.status,
    });
  }
  if (bond.withdrawalConsumed) {
    fail("REPLAYED_ATTESTATION", "Withdrawal already processed", {
      bondId: bond.bondId,
    });
  }
  return setBond(ledger, {
    ...bond,
    status: "WITHDRAWN",
    withdrawalConsumed: true,
  });
}
