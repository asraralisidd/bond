/**
 * Adapter request builders: validated, contract-compatible intents.
 *
 * These translate Phase 1/3 domain objects into the shapes the contract
 * entrypoints consume. Builders VALIDATE (freshness, subject consistency,
 * formats) but decide nothing: they never approve, never sign, never
 * submit. Submission mechanics (generated modules, proofs, wallet) are
 * Phase 5 work behind the same function names.
 */
import { DomainError } from "@bond/shared-types";
import type {
  Attestation,
  EnforcementAction,
  RiskFlag,
} from "@bond/shared-types";
import type { EnforcementDecisionInput } from "@bond/contract";

export interface RegistrationRequest {
  readonly kind: "register-agent";
  readonly agentId: string;
  readonly operatorId: string;
}

export interface BondLockRequest {
  readonly kind: "lock-bond";
  readonly bondId: string;
  readonly agentId: string;
  readonly operatorId: string;
  /** Opaque digit string; validated, never interpreted. */
  readonly commitmentMinorUnits: string;
}

export interface EnforcementRequest {
  readonly kind: "process-enforcement";
  readonly bondId: string;
  readonly decision: EnforcementDecisionInput;
}

export interface WithdrawalRequest {
  readonly kind: "withdraw-bond";
  readonly bondId: string;
  readonly operatorId: string;
}

function requireId(value: string, field: string): void {
  if (value.length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", `Invalid ${field}`, { field });
  }
}

export function buildRegistrationRequest(input: {
  readonly agentId: string;
  readonly operatorId: string;
}): RegistrationRequest {
  requireId(input.agentId, "agentId");
  requireId(input.operatorId, "operatorId");
  return {
    kind: "register-agent",
    agentId: input.agentId,
    operatorId: input.operatorId,
  };
}

export function buildBondLockRequest(input: {
  readonly bondId: string;
  readonly agentId: string;
  readonly operatorId: string;
  readonly commitmentMinorUnits: string;
}): BondLockRequest {
  requireId(input.bondId, "bondId");
  requireId(input.agentId, "agentId");
  requireId(input.operatorId, "operatorId");
  if (!/^[0-9]+$/.test(input.commitmentMinorUnits)) {
    throw new DomainError(
      "INVALID_IDENTIFIER",
      "commitment must be digits",
      {},
    );
  }
  return { ...input, kind: "lock-bond" };
}

/**
 * Builds the enforcement intent from a decided, fresh attestation plus
 * its flag. Rejects: missing/expired decisions, subject mismatch between
 * attestation and flag, and partial-slash without a valid amount.
 * The amount for partial slashes is caller-supplied policy data, validated
 * here and re-validated by the contract (never trusted).
 */
export function buildEnforcementRequest(input: {
  readonly bondId: string;
  readonly attestation: Attestation;
  readonly flag: RiskFlag;
  readonly amountMinorUnits?: string;
  readonly nowIso: string;
}): EnforcementRequest {
  requireId(input.bondId, "bondId");
  const { attestation, flag } = input;
  if (attestation.decision === null || attestation.status !== "decided") {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Enforcement requires a decided attestation",
      { status: attestation.status },
    );
  }
  if (
    (attestation.agentId as string) !== (flag.agentId as string) ||
    (attestation.riskFlagId as string) !== (flag.riskFlagId as string)
  ) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation/flag subject mismatch",
      {},
    );
  }
  if (Number.isNaN(Date.parse(input.nowIso))) {
    throw new DomainError("INVALID_TIMESTAMP", "Invalid nowIso", {});
  }
  if (Date.parse(input.nowIso) >= Date.parse(attestation.decision.expiresAt)) {
    throw new DomainError("EXPIRED_ATTESTATION", "Decision expired", {
      decisionId: attestation.decision.decisionId,
    });
  }
  const action: EnforcementAction = attestation.decision.action;
  if (action === "dismiss") {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Dismiss decisions carry no enforcement",
      {},
    );
  }
  let amountMinorUnits: string | undefined;
  if (action === "partial-slash") {
    if (
      input.amountMinorUnits === undefined ||
      !/^[0-9]+$/.test(input.amountMinorUnits)
    ) {
      throw new DomainError(
        "INVALID_ATTESTATION",
        "partial-slash requires a digit amount",
        {},
      );
    }
    amountMinorUnits = input.amountMinorUnits;
  }
  return {
    kind: "process-enforcement",
    bondId: input.bondId,
    decision: {
      decisionId: attestation.decision.decisionId as string,
      action,
      nullifier: attestation.decision.nullifier,
      expiresAt: attestation.decision.expiresAt,
      agentId: flag.agentId as string,
      riskFlagId: flag.riskFlagId as string,
      policyVersion: attestation.policyVersion,
      ...(amountMinorUnits === undefined ? {} : { amountMinorUnits }),
    },
  };
}

export function buildWithdrawalRequest(input: {
  readonly bondId: string;
  readonly operatorId: string;
}): WithdrawalRequest {
  requireId(input.bondId, "bondId");
  requireId(input.operatorId, "operatorId");
  return {
    kind: "withdraw-bond",
    bondId: input.bondId,
    operatorId: input.operatorId,
  };
}
