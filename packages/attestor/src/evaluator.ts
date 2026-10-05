/**
 * Independent attestor evaluation (EVAL-POLICY v1).
 *
 * This is the trust-critical step: the evaluator re-examines the
 * RiskFlag against available evidence under its own deterministic policy
 * — it does NOT convert flag → approval. Same flag, different attestor
 * context (evidence set, strictness) can and must be able to disagree.
 *
 * Policy v1 rules (documented, deterministic):
 * 1. Flag not actionable (status other than open/under-review) → throw.
 * 2. Flag evidence not ⊆ available evidence → ABSTAIN (cannot verify).
 * 3. Confidence < 0.5 → REJECT (too weak to act on, evidence seen).
 * 4. Severity low → ABSTAIN (below enforcement grade, never forced).
 * 5. Otherwise approve iff confidence ≥ threshold(severity) + strictness
 *    shift, where base thresholds are critical 0.6 / high 0.7 / medium
 *    0.85; lenient −0.1, strict +0.1 (clamped to [0, 1]).
 * 6. Within 0.2 below threshold → ABSTAIN (borderline, not forced);
 *    further below → REJECT.
 */
import { DomainError } from "@bond/shared-types";
import type { AttestorId, RiskFlag } from "@bond/shared-types";
import type { AttestationVerdict, RiskSeverity } from "@bond/shared-types";
import type { AttestorProfile } from "./attestor.js";
import { EVALUATION_POLICY_VERSION } from "./versions.js";

export type EvaluationOutcome = "approve" | "reject" | "abstain";

export interface IndependentEvaluation {
  readonly attestorId: AttestorId;
  readonly outcome: EvaluationOutcome;
  /** Verdict-compatible mapping (approve→confirm, reject→reject, abstain→abstain). */
  readonly verdict: AttestationVerdict;
  readonly reason: string;
  readonly evidenceComplete: boolean;
  readonly evaluatedAt: string;
  readonly policyVersion: typeof EVALUATION_POLICY_VERSION;
}

const BASE_THRESHOLDS: Readonly<Record<RiskSeverity, number>> = {
  critical: 0.6,
  high: 0.7,
  medium: 0.85,
  low: Number.POSITIVE_INFINITY,
};

const BORDERLINE_BAND = 0.2;

export function evaluateIndependently(
  profile: AttestorProfile,
  flag: RiskFlag,
  availableEvidenceIds: ReadonlySet<string>,
  evaluatedAt: string,
): IndependentEvaluation {
  if (flag.status !== "open" && flag.status !== "under-review") {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Only open/under-review flags can be evaluated",
      { riskFlagId: flag.riskFlagId, status: flag.status },
    );
  }
  const needed = flag.evidenceRefs.map((ref) => ref.evidenceId as string);
  const evidenceComplete = needed.every((id) => availableEvidenceIds.has(id));
  const base: Omit<IndependentEvaluation, "outcome" | "verdict" | "reason"> = {
    attestorId: profile.attestor.attestorId,
    evidenceComplete,
    evaluatedAt,
    policyVersion: EVALUATION_POLICY_VERSION,
  };
  if (!evidenceComplete) {
    return {
      ...base,
      outcome: "abstain",
      verdict: "abstain",
      reason:
        "incomplete-evidence: cannot verify without all referenced evidence",
    };
  }
  if (flag.confidence < 0.5) {
    return {
      ...base,
      outcome: "reject",
      verdict: "reject",
      reason: "finding-too-weak: confidence below actionable minimum",
    };
  }
  if (flag.severity === "low") {
    return {
      ...base,
      outcome: "abstain",
      verdict: "abstain",
      reason: "below-enforcement-grade: low severity never forces a verdict",
    };
  }
  const shift = profile.strictness * 0.1;
  const threshold = Math.min(
    1,
    Math.max(0, BASE_THRESHOLDS[flag.severity] + shift),
  );
  if (flag.confidence >= threshold) {
    return {
      ...base,
      outcome: "approve",
      verdict: "confirm",
      reason: `evidence-supports-finding: confidence ${flag.confidence} meets threshold ${threshold}`,
    };
  }
  if (flag.confidence >= threshold - BORDERLINE_BAND) {
    return {
      ...base,
      outcome: "abstain",
      verdict: "abstain",
      reason: `borderline: confidence ${flag.confidence} within ${BORDERLINE_BAND} below threshold ${threshold}`,
    };
  }
  return {
    ...base,
    outcome: "reject",
    verdict: "reject",
    reason: `evidence-does-not-support: confidence ${flag.confidence} below threshold ${threshold}`,
  };
}
