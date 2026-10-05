/**
 * Attestation domain: independent quorum decisions over risk flags.
 *
 * Follows Phase 0 doc 06. Deliberately free of cryptography, keys,
 * networking, and chain verification — those are Phase 3+ integration
 * boundaries. What this module DOES provide so later phases can enforce
 * the rules:
 * - request lifecycle with expiry,
 * - per-attestor verdicts with duplicate protection,
 * - quorum evaluation against a configurable threshold,
 * - freshness checks (injectable `now` for determinism),
 * - single-use decision semantics via nullifier tracking helpers.
 */
import { DomainError } from "./errors.js";
import type {
  AgentId,
  AttestationId,
  AttestorId,
  DecisionId,
  EvidenceId,
  RiskFlagId,
} from "./ids.js";
import type {
  AttestationStatus,
  AttestationVerdict,
  EnforcementAction,
  RiskSeverity,
} from "./enums.js";
import { isIsoTimestamp } from "./risk-flag.js";

export interface AttestorRef {
  readonly attestorId: AttestorId;
  readonly organization: string | null;
}

/**
 * Opaque binding reference. In later phases this carries (or points to)
 * the cryptographic binding of (request, flag, verdict, expiry). The
 * domain treats it as an opaque non-empty string — no algorithm assumed.
 */
export type VerdictBindingRef = string;

export interface AttestationVerdictRecord {
  readonly attestorId: AttestorId;
  readonly verdict: AttestationVerdict;
  readonly severityRecommendation: RiskSeverity | null;
  readonly rationaleRef: string | null;
  readonly bindingRef: VerdictBindingRef;
  readonly issuedAt: string;
}

export interface EnforcementDecision {
  readonly decisionId: DecisionId;
  readonly action: EnforcementAction;
  /** Single-use nullifier concept (Phase 0 doc 08); consumed on execution. */
  readonly nullifier: string;
  readonly expiresAt: string;
}

export interface Attestation {
  readonly attestationId: AttestationId;
  readonly riskFlagId: RiskFlagId;
  readonly agentId: AgentId;
  readonly evidenceRefs: readonly EvidenceId[];
  readonly policyVersion: string;
  /** Quorum size required (e.g. 2 for the 2-of-3 concept). Configurable. */
  readonly threshold: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly verdicts: readonly AttestationVerdictRecord[];
  readonly status: AttestationStatus;
  readonly decision: EnforcementDecision | null;
}

export interface CreateAttestationRequestInput {
  readonly attestationId: AttestationId;
  readonly riskFlagId: RiskFlagId;
  readonly agentId: AgentId;
  readonly evidenceRefs: readonly EvidenceId[];
  readonly policyVersion: string;
  readonly threshold: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface RecordVerdictInput {
  readonly attestorId: AttestorId;
  readonly verdict: AttestationVerdict;
  readonly severityRecommendation?: RiskSeverity | null;
  readonly rationaleRef?: string | null;
  readonly bindingRef: VerdictBindingRef;
  readonly issuedAt: string;
}

function assertTimestamp(value: string, field: string): void {
  if (!isIsoTimestamp(value)) {
    throw new DomainError("INVALID_TIMESTAMP", `Invalid timestamp: ${field}`, {
      field,
      value,
    });
  }
}

export function createAttestationRequest(
  input: CreateAttestationRequestInput,
): Attestation {
  if (!Number.isInteger(input.threshold) || input.threshold < 1) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation threshold must be a positive integer",
      { threshold: input.threshold },
    );
  }
  if (input.policyVersion.length === 0) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation policyVersion is required",
      {},
    );
  }
  assertTimestamp(input.requestedAt, "requestedAt");
  assertTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation expiresAt must be after requestedAt",
      {},
    );
  }
  return {
    attestationId: input.attestationId,
    riskFlagId: input.riskFlagId,
    agentId: input.agentId,
    evidenceRefs: input.evidenceRefs,
    policyVersion: input.policyVersion,
    threshold: input.threshold,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    verdicts: [],
    status: "requested",
    decision: null,
  };
}

/** Freshness at a given instant. `nowIso` is injected for determinism. */
export function isAttestationFresh(
  attestation: Pick<Attestation, "expiresAt">,
  nowIso: string,
): boolean {
  assertTimestamp(nowIso, "now");
  return Date.parse(nowIso) < Date.parse(attestation.expiresAt);
}

function countVerdicts(
  verdicts: readonly AttestationVerdictRecord[],
  verdict: AttestationVerdict,
): number {
  return verdicts.filter((v) => v.verdict === verdict).length;
}

/**
 * Records one verdict. Rejects duplicates from the same attestor, empty
 * bindings, and late verdicts (checked against `issuedAt` vs expiry —
 * deterministic, no clock reads). Returns the updated attestation with a
 * recomputed status: quorum-met | rejected | expired | requested.
 */
export function recordVerdict(
  attestation: Attestation,
  input: RecordVerdictInput,
): Attestation {
  if (attestation.status === "decided" || attestation.status === "rejected") {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Cannot record a verdict on a closed attestation",
      { attestationId: attestation.attestationId },
    );
  }
  if (attestation.verdicts.some((v) => v.attestorId === input.attestorId)) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Duplicate verdict from the same attestor",
      {
        attestationId: attestation.attestationId,
        attestorId: input.attestorId,
      },
    );
  }
  if (input.bindingRef.length === 0) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Verdict bindingRef is required",
      {},
    );
  }
  assertTimestamp(input.issuedAt, "issuedAt");
  if (Date.parse(input.issuedAt) >= Date.parse(attestation.expiresAt)) {
    throw new DomainError(
      "EXPIRED_ATTESTATION",
      "Verdict issued after expiry",
      {
        attestationId: attestation.attestationId,
      },
    );
  }
  const verdicts: readonly AttestationVerdictRecord[] = [
    ...attestation.verdicts,
    {
      attestorId: input.attestorId,
      verdict: input.verdict,
      severityRecommendation: input.severityRecommendation ?? null,
      rationaleRef: input.rationaleRef ?? null,
      bindingRef: input.bindingRef,
      issuedAt: input.issuedAt,
    },
  ];
  const confirms = countVerdicts(verdicts, "confirm");
  const rejects = countVerdicts(verdicts, "reject");
  const status: AttestationStatus =
    confirms >= attestation.threshold
      ? "quorum-met"
      : rejects >= attestation.threshold
        ? "rejected"
        : "requested";
  return { ...attestation, verdicts, status };
}

/**
 * Issues the single enforcement decision for a quorum-met attestation.
 * Requires freshness at `nowIso` and a caller-supplied unique nullifier;
 * the nullifier itself is opaque here — consumption is enforced on-chain
 * in later phases (see `isDecisionReplay`).
 */
export function issueDecision(
  attestation: Attestation,
  input: {
    readonly decisionId: DecisionId;
    readonly action: EnforcementAction;
    readonly nullifier: string;
    readonly decisionExpiresAt: string;
    readonly nowIso: string;
  },
): Attestation {
  if (attestation.decision !== null) {
    throw new DomainError(
      "REPLAYED_ATTESTATION",
      "A decision was already issued for this attestation",
      { attestationId: attestation.attestationId },
    );
  }
  if (attestation.status !== "quorum-met") {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Decision requires a quorum-met attestation",
      {
        attestationId: attestation.attestationId,
        status: attestation.status,
      },
    );
  }
  if (!isAttestationFresh(attestation, input.nowIso)) {
    throw new DomainError("EXPIRED_ATTESTATION", "Attestation expired", {
      attestationId: attestation.attestationId,
    });
  }
  if (input.nullifier.length === 0) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Decision nullifier is required",
      {},
    );
  }
  assertTimestamp(input.decisionExpiresAt, "decisionExpiresAt");
  return {
    ...attestation,
    status: "decided",
    decision: {
      decisionId: input.decisionId,
      action: input.action,
      nullifier: input.nullifier,
      expiresAt: input.decisionExpiresAt,
    },
  };
}

/**
 * Pure replay check: true when the decision nullifier is already consumed.
 * Later phases back `consumedNullifiers` with on-chain state.
 */
export function isDecisionReplay(
  decision: EnforcementDecision,
  consumedNullifiers: ReadonlySet<string>,
): boolean {
  return consumedNullifiers.has(decision.nullifier);
}
