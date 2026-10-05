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
import type { ReputationStanding } from "./enums.js";
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
