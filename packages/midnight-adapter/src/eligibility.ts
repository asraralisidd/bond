/**
 * ZK eligibility: BOND-level proof lifecycle around the Compact
 * proveEligibility / revokeEligibility / consumeEligibility circuits.
 *
 * Statement proven (collateral-sufficiency): "the operator controls an
 * eligible bond satisfying the configured policy for this agent" — with
 * the amount, salt, and secret as witnesses that NEVER leave the
 * operator's runtime and NEVER appear in any type below (no such fields
 * exist here by construction).
 *
 * Policy thresholds are explicit INPUT, never invented: Phase 0 leaves
 * the minimum unresolved, so callers supply requiredMinimumMinorUnits
 * from policy configuration.
 *
 * Lifecycle: CREATED → SUBMITTED → VERIFIED → CONSUMED, with EXPIRED /
 * REPLAYED / FAILED. SIMULATED fixtures are labeled SIMULATED-FIXTURE
 * and are never presented as ZK proofs.
 */
import { DomainError } from "@bond/shared-types";
import {
  amountToUint64,
  domainIdToBytes32,
  eligibilityNullifierToBytes32,
  policyVersionToBytes32,
} from "./encoding.js";

export const ELIGIBILITY_PURPOSES = ["collateral-sufficiency"] as const;
export type EligibilityPurpose = (typeof ELIGIBILITY_PURPOSES)[number];

export const ELIGIBILITY_PURPOSE_CODES: Readonly<
  Record<EligibilityPurpose, number>
> = {
  "collateral-sufficiency": 1,
};

export type EligibilityProofStatus =
  | "CREATED"
  | "SUBMITTED"
  | "VERIFIED"
  | "CONSUMED"
  | "EXPIRED"
  | "REPLAYED"
  | "FAILED";

export type EligibilityProofKind = "ZK-PROOF" | "SIMULATED-FIXTURE";

export interface EligibilityPolicyInput {
  readonly policyVersion: string;
  /** Explicit minimum from policy configuration — never invented here. */
  readonly requiredMinimumMinorUnits: string;
  readonly purpose: EligibilityPurpose;
}

/**
 * Public proof record. Contains NO private values by construction:
 * there is no amount, salt, secret, witness, or blinding field to leak.
 */
export interface EligibilityProof {
  readonly proofId: string;
  readonly kind: EligibilityProofKind;
  readonly agentId: string;
  readonly bondId: string;
  readonly policyVersion: string;
  readonly purpose: EligibilityPurpose;
  readonly nullifier: string;
  readonly expiresAt: string;
  readonly status: EligibilityProofStatus;
  readonly txId: string | null;
}

export interface CreateEligibilityProofInput {
  readonly proofId: string;
  readonly kind: EligibilityProofKind;
  readonly agentId: string;
  readonly bondId: string;
  readonly policy: EligibilityPolicyInput;
  readonly nullifier: string;
  readonly expiresAt: string;
  readonly nowIso: string;
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainError("INVALID_ELIGIBILITY_PROOF", `Invalid ${field}`, {
      field,
    });
  }
}

function assertTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new DomainError("INVALID_TIMESTAMP", `Invalid ${field}`, { field });
  }
}

export function createEligibilityProof(
  input: CreateEligibilityProofInput,
): EligibilityProof {
  requireText(input.proofId, "proofId");
  requireText(input.agentId, "agentId");
  requireText(input.bondId, "bondId");
  requireText(input.policy.policyVersion, "policyVersion");
  if (input.kind !== "ZK-PROOF" && input.kind !== "SIMULATED-FIXTURE") {
    throw new DomainError("INVALID_ELIGIBILITY_PROOF", "Unknown proof kind", {
      kind: input.kind,
    });
  }
  requireText(input.nullifier, "nullifier");
  if (!ELIGIBILITY_PURPOSES.includes(input.policy.purpose)) {
    throw new DomainError("INVALID_ELIGIBILITY_PROOF", "Unknown purpose", {
      purpose: input.policy.purpose,
    });
  }
  // Validates digit shape + Uint<64> range without interpreting value.
  amountToUint64(input.policy.requiredMinimumMinorUnits);
  assertTimestamp(input.expiresAt, "expiresAt");
  assertTimestamp(input.nowIso, "nowIso");
  if (Date.parse(input.nowIso) >= Date.parse(input.expiresAt)) {
    throw new DomainError(
      "EXPIRED_ELIGIBILITY_PROOF",
      "Proof already expired",
      {
        proofId: input.proofId,
      },
    );
  }
  return {
    proofId: input.proofId,
    kind: input.kind,
    agentId: input.agentId,
    bondId: input.bondId,
    policyVersion: input.policy.policyVersion,
    purpose: input.policy.purpose,
    nullifier: input.nullifier,
    expiresAt: input.expiresAt,
    status: "CREATED",
    txId: null,
  };
}

const PROOF_TRANSITIONS: Readonly<
  Record<EligibilityProofStatus, readonly EligibilityProofStatus[]>
> = {
  CREATED: ["SUBMITTED", "EXPIRED", "FAILED"],
  SUBMITTED: ["VERIFIED", "EXPIRED", "REPLAYED", "FAILED"],
  VERIFIED: ["CONSUMED", "EXPIRED"],
  CONSUMED: [],
  EXPIRED: [],
  REPLAYED: [],
  FAILED: [],
};

/** Deterministic lifecycle step. Expiry is evaluated against nowIso. */
export function transitionEligibilityProof(
  proof: EligibilityProof,
  to: EligibilityProofStatus,
  nowIso: string,
): EligibilityProof {
  assertTimestamp(nowIso, "nowIso");
  if (Date.parse(nowIso) >= Date.parse(proof.expiresAt)) {
    if (to !== "EXPIRED" && proof.status !== "EXPIRED") {
      throw new DomainError(
        "EXPIRED_ELIGIBILITY_PROOF",
        "Proof expired before transition",
        { proofId: proof.proofId },
      );
    }
  }
  if (!PROOF_TRANSITIONS[proof.status].includes(to)) {
    throw new DomainError(
      "INVALID_ELIGIBILITY_PROOF",
      `Invalid proof transition: ${proof.status} → ${to}`,
      { proofId: proof.proofId, from: proof.status, to },
    );
  }
  return { ...proof, status: to };
}

/** Domain-separated nullifier derivation (opaque strings; bytes at submit). */
export function deriveProofNullifier(
  agentId: string,
  purpose: EligibilityPurpose,
  nonce: string,
): string {
  requireText(nonce, "nonce");
  return `eligibility-proof:${agentId}:${purpose}:${nonce}`;
}

export function deriveRedemptionNullifier(
  agentId: string,
  proofId: string,
  nonce: string,
): string {
  requireText(nonce, "nonce");
  return `eligibility-redeem:${agentId}:${proofId}:${nonce}`;
}

/** REAL circuit args for proveEligibility (all public-safe inputs). */
export function eligibilityCircuitArgs(input: {
  readonly agentId: string;
  readonly policyVersion: string;
  readonly purpose: EligibilityPurpose;
  readonly requiredMinimumMinorUnits: string;
  readonly nullifier: string;
}): readonly (Uint8Array | bigint)[] {
  return [
    domainIdToBytes32(input.agentId),
    policyVersionToBytes32(input.policyVersion),
    BigInt(ELIGIBILITY_PURPOSE_CODES[input.purpose]),
    amountToUint64(input.requiredMinimumMinorUnits),
    eligibilityNullifierToBytes32(input.nullifier),
  ];
}

export type EligibilityCheckReason =
  | "no-record"
  | "revoked"
  | "consumed"
  | "policy-mismatch"
  | "purpose-mismatch"
  | "expired"
  | "eligible";

export interface EligibilityCheckResult {
  readonly eligible: boolean;
  readonly reason: EligibilityCheckReason;
}

/**
 * Public verification decision over a ledger/oracle record. Pure:
 * eligible ONLY when record exists, unrevoked, unconsumed, policy- and
 * purpose-bound, and unexpired. Answers nothing about private values —
 * the inputs contain none.
 */
export function checkEligibility(input: {
  readonly record: {
    readonly policyHashHex: string;
    readonly purposeCode: number;
    readonly revoked: boolean;
    readonly consumed: boolean;
  } | null;
  readonly expectedPolicyHashHex: string;
  readonly expectedPurposeCode: number;
  readonly expiresAt: string;
  readonly nowIso: string;
}): EligibilityCheckResult {
  assertTimestamp(input.nowIso, "nowIso");
  assertTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(input.nowIso) >= Date.parse(input.expiresAt)) {
    return { eligible: false, reason: "expired" };
  }
  if (input.record === null) {
    return { eligible: false, reason: "no-record" };
  }
  if (input.record.revoked) {
    return { eligible: false, reason: "revoked" };
  }
  if (input.record.consumed) {
    return { eligible: false, reason: "consumed" };
  }
  if (input.record.policyHashHex !== input.expectedPolicyHashHex) {
    return { eligible: false, reason: "policy-mismatch" };
  }
  if (input.record.purposeCode !== input.expectedPurposeCode) {
    return { eligible: false, reason: "purpose-mismatch" };
  }
  return { eligible: true, reason: "eligible" };
}

export interface PublicEligibilityView {
  readonly agentId: string;
  readonly eligible: boolean;
  readonly reason: EligibilityCheckReason;
  readonly policyVersion: string;
  readonly purpose: EligibilityPurpose;
  readonly proofStatus: EligibilityProofStatus;
  readonly asOf: string;
}

/** Allowlisted public view — fresh object, never a spread of internals. */
export function toPublicEligibilityView(input: {
  readonly agentId: string;
  readonly check: EligibilityCheckResult;
  readonly policyVersion: string;
  readonly purpose: EligibilityPurpose;
  readonly proofStatus: EligibilityProofStatus;
  readonly asOf: string;
}): PublicEligibilityView {
  return {
    agentId: input.agentId,
    eligible: input.check.eligible,
    reason: input.check.reason,
    policyVersion: input.policyVersion,
    purpose: input.purpose,
    proofStatus: input.proofStatus,
    asOf: input.asOf,
  };
}

export interface SimulatedEligibilityEntry {
  readonly proof: EligibilityProof;
  readonly revoked: boolean;
  readonly consumed: boolean;
}

export interface SimulatedEligibilityStore {
  /** Records a proven statement; enforces binding, expiry, replay. */
  readonly prove: (
    proof: EligibilityProof,
    nowIso: string,
  ) => SimulatedEligibilityEntry;
  readonly revoke: (
    agentId: string,
    nowIso: string,
  ) => SimulatedEligibilityEntry;
  readonly consume: (
    agentId: string,
    redemptionNullifier: string,
    nowIso: string,
  ) => SimulatedEligibilityEntry;
  readonly read: (agentId: string) => SimulatedEligibilityEntry | null;
}

/**
 * Labeled in-memory eligibility registry. Applies the SAME validation
 * semantics as the on-chain circuits (binding per agent, expiry,
 * single-use nullifiers) WITHOUT any ZK: entries are
 * SIMULATED-FIXTURE records, never proofs. Deterministic.
 */
export function createSimulatedEligibilityStore(): SimulatedEligibilityStore {
  const entries = new Map<string, SimulatedEligibilityEntry>();
  const consumedNullifiers = new Set<string>();

  function assertUsable(proof: EligibilityProof, nowIso: string): void {
    if (Number.isNaN(Date.parse(nowIso))) {
      throw new DomainError("INVALID_TIMESTAMP", "Invalid nowIso", {});
    }
    if (Date.parse(nowIso) >= Date.parse(proof.expiresAt)) {
      throw new DomainError("EXPIRED_ELIGIBILITY_PROOF", "Proof expired", {
        proofId: proof.proofId,
      });
    }
    if (consumedNullifiers.has(proof.nullifier)) {
      throw new DomainError(
        "REPLAYED_ELIGIBILITY_PROOF",
        "Proof nullifier already consumed",
        { proofId: proof.proofId },
      );
    }
  }

  return {
    prove(proof, nowIso) {
      assertUsable(proof, nowIso);
      consumedNullifiers.add(proof.nullifier);
      const entry: SimulatedEligibilityEntry = {
        proof: { ...proof, status: "VERIFIED" },
        revoked: false,
        consumed: false,
      };
      entries.set(proof.agentId, entry);
      return entry;
    },
    revoke(agentId, nowIso) {
      if (Number.isNaN(Date.parse(nowIso))) {
        throw new DomainError("INVALID_TIMESTAMP", "Invalid nowIso", {});
      }
      const existing = entries.get(agentId);
      if (existing === undefined) {
        throw new DomainError(
          "INVALID_ELIGIBILITY_PROOF",
          "No eligibility record",
          { agentId },
        );
      }
      const entry: SimulatedEligibilityEntry = { ...existing, revoked: true };
      entries.set(agentId, entry);
      return entry;
    },
    consume(agentId, redemptionNullifier, nowIso) {
      if (Number.isNaN(Date.parse(nowIso))) {
        throw new DomainError("INVALID_TIMESTAMP", "Invalid nowIso", {});
      }
      const existing = entries.get(agentId);
      if (existing === undefined) {
        throw new DomainError(
          "INVALID_ELIGIBILITY_PROOF",
          "No eligibility record",
          { agentId },
        );
      }
      if (existing.revoked) {
        throw new DomainError(
          "INVALID_ELIGIBILITY_PROOF",
          "Eligibility revoked",
          { agentId },
        );
      }
      if (existing.consumed) {
        throw new DomainError(
          "REPLAYED_ELIGIBILITY_PROOF",
          "Eligibility already consumed",
          { agentId },
        );
      }
      if (redemptionNullifier.trim().length === 0) {
        throw new DomainError(
          "INVALID_ELIGIBILITY_PROOF",
          "Redemption nullifier required",
          {},
        );
      }
      if (consumedNullifiers.has(redemptionNullifier)) {
        throw new DomainError(
          "REPLAYED_ELIGIBILITY_PROOF",
          "Redemption nullifier already consumed",
          { agentId },
        );
      }
      if (Date.parse(nowIso) >= Date.parse(existing.proof.expiresAt)) {
        throw new DomainError("EXPIRED_ELIGIBILITY_PROOF", "Proof expired", {
          proofId: existing.proof.proofId,
        });
      }
      consumedNullifiers.add(redemptionNullifier);
      const entry: SimulatedEligibilityEntry = {
        proof: { ...existing.proof, status: "CONSUMED" },
        revoked: false,
        consumed: true,
      };
      entries.set(agentId, entry);
      return entry;
    },
    read(agentId) {
      return entries.get(agentId) ?? null;
    },
  };
}
