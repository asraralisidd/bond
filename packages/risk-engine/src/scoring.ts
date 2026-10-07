/**
 * Deterministic scoring model (SCORING v1).
 *
 * Integer arithmetic throughout: no floats inside scoring, so results are
 * bit-stable across platforms. Confidence travels as integer 0–100 until
 * the RiskFlag boundary, where it converts to 0–1.
 *
 * Formula (documented, explainable, no magic):
 *   severityPoints: low=10, medium=25, high=50, critical=80
 *   score = min(100, maxPoints + 5 × (findings − 1))
 * The top finding contributes fully; each additional finding adds breadth.
 * Result severity = max severity; result confidence = max confidence
 * (independent dimensions — see rules.ts).
 */
import type { RiskSeverity } from "@bond/shared-types";
import type { RuleFinding } from "./rules.js";
import { SCORING_MODEL_VERSION, SCORING_V2, SCORING_V3 } from "./versions.js";

export const SEVERITY_POINTS: Readonly<Record<RiskSeverity, number>> = {
  low: 10,
  medium: 25,
  high: 50,
  critical: 80,
};

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface ScoreFactor {
  readonly ruleId: string;
  readonly category: string;
  readonly severity: RiskSeverity;
  readonly severityPoints: number;
  /** Integer 0–100. */
  readonly confidence: number;
  /** Points this finding contributed to the total. */
  readonly contribution: number;
}

export interface RiskScore {
  /** Integer 0–100. */
  readonly score: number;
  readonly severity: RiskSeverity;
  /** Integer 0–100 (converted to 0–1 at the RiskFlag boundary). */
  readonly confidence: number;
  readonly factors: readonly ScoreFactor[];
  /**
   * Scoring tag. Widened to string in Phase 20 so v2 scores fit the
   * same shape; v1 path still stamps exactly `scoring-v1`.
   */
  readonly scoringVersion: string;
}

const BREADTH_POINTS = 5;

export function scoreFindings(
  findings: readonly RuleFinding[],
): RiskScore | null {
  if (findings.length === 0) {
    return null;
  }
  let maxPoints = 0;
  let maxRank = -1;
  let topSeverity: RiskSeverity = "low";
  let maxConfidence = 0;
  for (const finding of findings) {
    const points = SEVERITY_POINTS[finding.severity];
    if (points > maxPoints) {
      maxPoints = points;
    }
    if (SEVERITY_RANK[finding.severity] > maxRank) {
      maxRank = SEVERITY_RANK[finding.severity];
      topSeverity = finding.severity;
    }
    if (finding.confidence > maxConfidence) {
      maxConfidence = finding.confidence;
    }
  }
  const score = Math.min(
    100,
    maxPoints + BREADTH_POINTS * (findings.length - 1),
  );
  const topIndex = findings.findIndex(
    (finding) => SEVERITY_POINTS[finding.severity] === maxPoints,
  );
  const factors: ScoreFactor[] = findings.map((finding, index) => {
    // The first max-point finding contributes fully; the rest add breadth.
    const contribution = index === topIndex ? maxPoints : BREADTH_POINTS;
    return {
      ruleId: finding.ruleId,
      category: finding.category,
      severity: finding.severity,
      severityPoints: SEVERITY_POINTS[finding.severity],
      confidence: finding.confidence,
      contribution,
    };
  });
  return {
    score,
    severity: topSeverity,
    confidence: maxConfidence,
    factors,
    scoringVersion: SCORING_MODEL_VERSION,
  };
}

/**
 * Behavioral breadth cap: extra breadth from behavioral findings is
 * capped so statistics cannot inflate a score without bound.
 */
const BEHAVIORAL_BREADTH_POINTS = 2;
const BEHAVIORAL_BREADTH_CAP = 8;

/**
 * Phase 20 scoring-v2. Does NOT alter `scoreFindings`: v1-only
 * analyses keep byte-identical scores. When behavioral findings
 * exist, the total preserves the v1 score as the floor, takes the
 * stronger of the v1 and behavioral sub-scores, and adds small
 * capped breadth for multiple behavioral signals:
 *
 *   total = min(100, max(v1, behavioral) + min(8, 2 × (n − 1)))
 *
 * Behavioral severities never exceed high (enforced by the
 * detectors), so v2 can never manufacture a CRITICAL on its own;
 * a v1 CRITICAL passes through unchanged.
 */
export function scoreWithBehavioral(
  v1: RiskScore | null,
  behavioral: readonly RuleFinding[],
): RiskScore | null {
  if (behavioral.length === 0) {
    return v1;
  }
  const sub = scoreFindings(behavioral);
  const behavioralBase = sub === null ? 0 : sub.score;
  const v1Score = v1 === null ? 0 : v1.score;
  const breadth = Math.min(
    BEHAVIORAL_BREADTH_CAP,
    BEHAVIORAL_BREADTH_POINTS * (behavioral.length - 1),
  );
  const total = Math.min(100, Math.max(v1Score, behavioralBase) + breadth);
  const delta = Math.max(0, total - v1Score);
  const v1Factors = v1 === null ? [] : v1.factors;
  const behavioralFactors: ScoreFactor[] = (sub?.factors ?? []).map(
    (factor, index) => ({
      ...factor,
      // The behavioral addition lands on the first behavioral
      // factor; the rest are informational (contribution 0).
      contribution: index === 0 ? delta : 0,
    }),
  );
  let severity: RiskSeverity = v1 === null ? "low" : v1.severity;
  let confidence = v1 === null ? 0 : v1.confidence;
  for (const item of behavioral) {
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[severity]) {
      severity = item.severity;
    }
    if (item.confidence > confidence) {
      confidence = item.confidence;
    }
  }
  return {
    score: total,
    severity,
    confidence,
    factors: [...v1Factors, ...behavioralFactors],
    scoringVersion: SCORING_V2,
  };
}

/**
 * Phase 22 scoring-v3. Same contract as scoring-v2: the incoming
 * score (v1-only or v2-composed) is the floor, the policy sub-score
 * competes, and capped breadth (+2 per extra policy finding, cap +8)
 * rewards multiple distinct violations without unbounded inflation:
 *
 *   total = min(100, max(base, policy) + min(8, 2 × (n − 1)))
 *
 * Policy severities never exceed high (enforced by the evaluator),
 * so v3 can never manufacture a CRITICAL on its own; a v1/v2
 * CRITICAL passes through unchanged.
 */
export function scoreWithPolicy(
  base: RiskScore | null,
  policyFindings: readonly RuleFinding[],
): RiskScore | null {
  if (policyFindings.length === 0) {
    return base;
  }
  const sub = scoreFindings(policyFindings);
  const policyBase = sub === null ? 0 : sub.score;
  const baseScore = base === null ? 0 : base.score;
  const breadth = Math.min(8, 2 * (policyFindings.length - 1));
  const total = Math.min(100, Math.max(baseScore, policyBase) + breadth);
  const delta = Math.max(0, total - baseScore);
  const baseFactors = base === null ? [] : base.factors;
  const policyFactors: ScoreFactor[] = (sub?.factors ?? []).map(
    (factor, index) => ({
      ...factor,
      contribution: index === 0 ? delta : 0,
    }),
  );
  let severity: RiskSeverity = base === null ? "low" : base.severity;
  let confidence = base === null ? 0 : base.confidence;
  for (const item of policyFindings) {
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[severity]) {
      severity = item.severity;
    }
    if (item.confidence > confidence) {
      confidence = item.confidence;
    }
  }
  return {
    score: total,
    severity,
    confidence,
    factors: [...baseFactors, ...policyFactors],
    scoringVersion: SCORING_V3,
  };
}
