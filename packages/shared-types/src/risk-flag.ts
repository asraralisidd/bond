/**
 * RiskFlag domain: advisory decision-support information only.
 *
 * SECURITY RULE (Phase 0 doc 05): Risk Engine output has ZERO enforcement
 * power. This module contains no chain calls, no signing, no fund
 * movement — only flag construction, validation, and status transitions.
 * A flag can open review and request expedited attestation; that is all.
 */
import { DomainError } from "./errors.js";
import type { AgentId, EvidenceId, RiskFlagId } from "./ids.js";
import type {
  EvidenceCategory,
  RiskCategory,
  RiskFlagStatus,
  RiskSeverity,
} from "./enums.js";

/** Evidence descriptor: hashes/pointers only, never raw private content. */
export interface EvidenceRef {
  readonly evidenceId: EvidenceId;
  readonly category: EvidenceCategory;
  /** Integrity hash of the underlying content (opaque to the domain). */
  readonly contentHash: string;
}

export interface RiskFlag {
  readonly riskFlagId: RiskFlagId;
  readonly agentId: AgentId;
  readonly category: RiskCategory;
  readonly severity: RiskSeverity;
  /** Model confidence in [0, 1]. */
  readonly confidence: number;
  /** At least one evidence reference is required (Phase 0 doc 13). */
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly detectedAt: string;
  /** Scorer identity + config version (reproducibility, Phase 0 doc 05). */
  readonly modelVersion: string;
  readonly status: RiskFlagStatus;
  /** Link to a revised assessment; null when this flag is the latest. */
  readonly supersedes: RiskFlagId | null;
}

export interface CreateRiskFlagInput {
  readonly riskFlagId: RiskFlagId;
  readonly agentId: AgentId;
  readonly category: RiskCategory;
  readonly severity: RiskSeverity;
  readonly confidence: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly detectedAt: string;
  readonly modelVersion: string;
  readonly supersedes?: RiskFlagId | null;
}

const RISK_FLAG_TRANSITIONS: Readonly<
  Record<RiskFlagStatus, readonly RiskFlagStatus[]>
> = {
  open: ["under-review", "dismissed", "expired"],
  "under-review": ["attested", "dismissed", "expired"],
  attested: [],
  dismissed: [],
  expired: [],
};

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!isIsoTimestamp(value)) {
    throw new DomainError("INVALID_TIMESTAMP", `Invalid timestamp: ${field}`, {
      field,
      value,
    });
  }
}

/** Validates and constructs a RiskFlag. New flags always start `open`. */
export function createRiskFlag(input: CreateRiskFlagInput): RiskFlag {
  if (
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new DomainError(
      "INVALID_RISK_FLAG",
      "RiskFlag confidence must be within [0, 1]",
      { confidence: input.confidence },
    );
  }
  if (input.evidenceRefs.length === 0) {
    throw new DomainError(
      "INVALID_RISK_FLAG",
      "RiskFlag requires at least one evidence reference",
      { riskFlagId: input.riskFlagId },
    );
  }
  if (input.modelVersion.length === 0) {
    throw new DomainError(
      "INVALID_RISK_FLAG",
      "RiskFlag modelVersion is required",
      {
        riskFlagId: input.riskFlagId,
      },
    );
  }
  assertIsoTimestamp(input.detectedAt, "detectedAt");
  return {
    riskFlagId: input.riskFlagId,
    agentId: input.agentId,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    evidenceRefs: input.evidenceRefs,
    detectedAt: input.detectedAt,
    modelVersion: input.modelVersion,
    status: "open",
    supersedes: input.supersedes ?? null,
  };
}

export function canTransitionRiskFlag(
  from: RiskFlagStatus,
  to: RiskFlagStatus,
): boolean {
  return RISK_FLAG_TRANSITIONS[from].includes(to);
}

/** Deterministic flag status transition; throws on invalid moves. */
export function transitionRiskFlagStatus(
  flag: RiskFlag,
  to: RiskFlagStatus,
): RiskFlag {
  if (!canTransitionRiskFlag(flag.status, to)) {
    throw new DomainError(
      "INVALID_RISK_FLAG_TRANSITION",
      `Invalid risk flag transition: ${flag.status} → ${to}`,
      { riskFlagId: flag.riskFlagId, from: flag.status, to },
    );
  }
  return { ...flag, status: to };
}
