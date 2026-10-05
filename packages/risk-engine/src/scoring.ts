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
import { SCORING_MODEL_VERSION } from "./versions.js";

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
  readonly scoringVersion: typeof SCORING_MODEL_VERSION;
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
