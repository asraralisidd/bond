/**
 * Reputation domain: derived, deterministic, non-token standing.
 *
 * Phase 0 doc 07: reputation is computed from append-only history, never
 * self-asserted, never edited. This module implements a `v0` derivation
 * with explicit, documented weights — a starting policy for Phase 2+ to
 * refine, not a final economy. No transfers, no markets, no tokens.
 */
import { DomainError } from "./errors.js";
import type { AgentId, ProtocolEventId, ReputationId } from "./ids.js";
import type { ReputationStanding, RiskSeverity } from "./enums.js";
import { isIsoTimestamp } from "./risk-flag.js";

/** Version tag for the derivation policy. Bump on any weight change. */
export const REPUTATION_MODEL_VERSION = "v0" as const;

export interface ReputationFactors {
  readonly confirmedFlags: number;
  readonly partialSlashes: number;
  readonly fullSlashes: number;
  readonly cleanBondsCompleted: number;
  /** Resolved incidents with remediation (partial restoration, doc 07). */
  readonly remediatedResolutions: number;
}

export interface ReputationRecord {
  readonly reputationId: ReputationId;
  readonly agentId: AgentId;
  /** Deterministic score in [0, 100]. */
  readonly score: number;
  readonly standing: ReputationStanding;
  readonly factors: ReputationFactors;
  /** Triggering event for this record (event-sourced, doc 07 §7.3). */
  readonly triggeredByEvent: ProtocolEventId;
  readonly modelVersion: typeof REPUTATION_MODEL_VERSION;
  readonly updatedAt: string;
}

export interface DeriveReputationInput {
  readonly reputationId: ReputationId;
  readonly agentId: AgentId;
  readonly factors: ReputationFactors;
  readonly triggeredByEvent: ProtocolEventId;
  readonly updatedAt: string;
}

function assertNonNegativeInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError(
      "INVALID_REPUTATION_INPUT",
      `Reputation factor ${field} must be a non-negative integer`,
      { field, value },
    );
  }
}

export function standingForScore(score: number): ReputationStanding {
  if (score >= 70) {
    return "good";
  }
  if (score >= 40) {
    return "probation";
  }
  return "poor";
}

/**
 * Deterministic v0 derivation, replayable from history:
 * start at 100; −25 per full slash, −10 per partial slash, −5 per
 * confirmed flag; +5 per cleanly completed bond, +3 per remediated
 * resolution; clamped to [0, 100]. Dismissed/unconfirmed flags MUST NOT
 * be counted in `confirmedFlags` (accusation is not guilt, doc 07).
 */
export function deriveReputation(
  input: DeriveReputationInput,
): ReputationRecord {
  const f = input.factors;
  assertNonNegativeInt(f.confirmedFlags, "confirmedFlags");
  assertNonNegativeInt(f.partialSlashes, "partialSlashes");
  assertNonNegativeInt(f.fullSlashes, "fullSlashes");
  assertNonNegativeInt(f.cleanBondsCompleted, "cleanBondsCompleted");
  assertNonNegativeInt(f.remediatedResolutions, "remediatedResolutions");
  if (!isIsoTimestamp(input.updatedAt)) {
    throw new DomainError(
      "INVALID_TIMESTAMP",
      "Invalid timestamp: updatedAt",
      {},
    );
  }
  const raw =
    100 -
    25 * f.fullSlashes -
    10 * f.partialSlashes -
    5 * f.confirmedFlags +
    5 * f.cleanBondsCompleted +
    3 * f.remediatedResolutions;
  const score = Math.min(100, Math.max(0, raw));
  return {
    reputationId: input.reputationId,
    agentId: input.agentId,
    score,
    standing: standingForScore(score),
    factors: { ...f },
    triggeredByEvent: input.triggeredByEvent,
    modelVersion: REPUTATION_MODEL_VERSION,
    updatedAt: input.updatedAt,
  };
}

/**
 * Phase 21 event-sourced trust layer (reputation-v1).
 *
 * Complements (does NOT replace) the v0 snapshot derivation above:
 * v0 recomputes a score from aggregate counts; v1 applies discrete,
 * explained, idempotent impacts from individual verified protocol
 * outcomes. Both are advisory — neither authorizes enforcement.
 *
 * Reputation is advisory trust intelligence and does not directly
 * authorize or execute enforcement.
 */

/** Version tag for the v1 event-sourced policy. */
export const REPUTATION_VERSION = "reputation-v1" as const;

/**
 * Score for agents with no reputation history. Mid-HIGH band: a
 * single small observation preserves the band, while verified
 * outcomes move it. New agents are trusted by default (consistent
 * with v0 starting at 100) but one attested violation is enough to
 * leave HIGH — evidence, not time, builds higher trust.
 */
export const REPUTATION_BASELINE_SCORE = 75 as const;

/** Five trust bands. Boundaries nest inside the v0 standing bands:
 * VERY_LOW/LOW ⊂ poor (<40); MODERATE ⊂ probation (40–69);
 * HIGH/VERY_HIGH ⊂ good (≥70). */
export type TrustLevel = "VERY_LOW" | "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";

export function trustLevelForScore(score: number): TrustLevel {
  if (score >= 90) {
    return "VERY_HIGH";
  }
  if (score >= 70) {
    return "HIGH";
  }
  if (score >= 50) {
    return "MODERATE";
  }
  if (score >= 25) {
    return "LOW";
  }
  return "VERY_LOW";
}

/**
 * Reputation event types. Observed risk (a raw RiskFlag) is a
 * different, weaker signal than a verified outcome — the impact
 * table below encodes that ordering explicitly.
 */
export type ReputationEventType =
  | "risk_flag_observed"
  | "attested_violation"
  | "attestation_dismissed"
  | "slash_enforced"
  | "clean_bond_completed";

export type ReputationSourceType =
  "risk_flag" | "attestation" | "slash_event" | "bond";

export interface ReputationImpactInput {
  readonly eventType: ReputationEventType;
  /** Required for severity-weighted types; ignored otherwise. */
  readonly severity?: RiskSeverity;
  /** Required for slash_enforced: full vs partial slash. */
  readonly fullSlash?: boolean;
  /** Flag category for observed/attested context (display only). */
  readonly category?: string;
}

export interface ReputationImpact {
  readonly impact: number;
  readonly reasonCode: string;
  readonly reason: string;
}

const OBSERVED_IMPACT: Readonly<Record<RiskSeverity, number>> = {
  low: -1,
  medium: -2,
  high: -5,
  critical: -8,
};

const ATTESTED_IMPACT: Readonly<Record<RiskSeverity, number>> = {
  low: -3,
  medium: -6,
  high: -12,
  critical: -20,
};

function upperSeverity(severity: RiskSeverity): string {
  return severity.toUpperCase();
}

function requireSeverity(
  input: ReputationImpactInput,
  eventType: ReputationEventType,
): RiskSeverity {
  const severity = input.severity;
  if (
    severity !== "low" &&
    severity !== "medium" &&
    severity !== "high" &&
    severity !== "critical"
  ) {
    throw new DomainError(
      "INVALID_REPUTATION_INPUT",
      `Reputation event ${eventType} requires a valid severity`,
      { eventType, severity },
    );
  }
  return severity;
}

/**
 * Deterministic impact policy (integers only). Verified outcomes
 * outweigh raw observations by construction:
 * - observed flag: −1/−2/−5/−8 by severity
 * - attested violation: −3/−6/−12/−20 by severity
 * - dismissal (exoneration): +2
 * - slash enforced: −15 partial, −30 full
 * - clean bond completed: +3
 * Positives flow only from verified outcomes (never raw activity),
 * so reputation cannot be farmed by submitting benign analyses.
 */
export function impactForEvent(input: ReputationImpactInput): ReputationImpact {
  switch (input.eventType) {
    case "risk_flag_observed": {
      const severity = requireSeverity(input, input.eventType);
      return {
        impact: OBSERVED_IMPACT[severity],
        reasonCode: `OBSERVED_${upperSeverity(severity)}_RISK`,
        reason:
          `Automated risk analysis observed ${severity}-severity behavior` +
          (input.category ? ` (${input.category})` : "") +
          ". Observation only — not a confirmed violation.",
      };
    }
    case "attested_violation": {
      const severity = requireSeverity(input, input.eventType);
      return {
        impact: ATTESTED_IMPACT[severity],
        reasonCode: `ATTESTED_${upperSeverity(severity)}_VIOLATION`,
        reason:
          `An independent attestation quorum confirmed a ${severity}-severity violation` +
          (input.category ? ` (${input.category})` : "") +
          ".",
      };
    }
    case "attestation_dismissed":
      return {
        impact: 2,
        reasonCode: "ATTESTATION_DISMISSED",
        reason:
          "Independent attestors reviewed the flag and dismissed it; no violation confirmed.",
      };
    case "slash_enforced": {
      if (input.fullSlash === true) {
        return {
          impact: -30,
          reasonCode: "SLASH_FULL",
          reason:
            "Enforcement executed a full slash against the agent bond following an attested decision.",
        };
      }
      return {
        impact: -15,
        reasonCode: "SLASH_PARTIAL",
        reason:
          "Enforcement executed a partial slash against the agent bond following an attested decision.",
      };
    }
    case "clean_bond_completed":
      return {
        impact: 3,
        reasonCode: "CLEAN_BOND_COMPLETED",
        reason:
          "The agent completed a bond lifecycle cleanly with funds withdrawn.",
      };
  }
}

export interface ReputationExplanation {
  readonly eventType: ReputationEventType;
  readonly sourceType: ReputationSourceType;
  readonly sourceId: string;
  readonly impact: number;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly version: typeof REPUTATION_VERSION;
}

export interface ApplyReputationEventInput extends ReputationImpactInput {
  readonly scoreBefore: number;
  readonly sourceType: ReputationSourceType;
  readonly sourceId: string;
}

function assertScore(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new DomainError(
      "INVALID_REPUTATION_INPUT",
      `Reputation ${field} must be an integer in [0, 100]`,
      { field, value },
    );
  }
}

/**
 * Pure state transition: clamp(scoreBefore + impact, 0, 100) with a
 * full explanation. No I/O, no clock, no randomness — the caller
 * supplies everything, so identical inputs replay identically.
 */
export function applyReputationEvent(
  input: ApplyReputationEventInput,
): ReputationExplanation & { readonly scoreAfter: number } {
  assertScore(input.scoreBefore, "scoreBefore");
  if (typeof input.sourceId !== "string" || input.sourceId.length === 0) {
    throw new DomainError(
      "INVALID_REPUTATION_INPUT",
      "Reputation event requires a non-empty sourceId",
      { sourceType: input.sourceType },
    );
  }
  const { impact, reasonCode, reason } = impactForEvent(input);
  const scoreAfter = Math.min(100, Math.max(0, input.scoreBefore + impact));
  return {
    eventType: input.eventType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    impact,
    scoreBefore: input.scoreBefore,
    scoreAfter,
    reasonCode,
    reason,
    version: REPUTATION_VERSION,
  };
}
