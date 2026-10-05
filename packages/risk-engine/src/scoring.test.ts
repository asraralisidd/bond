import { describe, expect, it } from "vitest";
import { scoreFindings, SEVERITY_POINTS } from "./scoring.js";
import type { RuleFinding } from "./rules.js";
import { RULE_SET_VERSION } from "./versions.js";

function finding(
  ruleId: string,
  severity: RuleFinding["severity"],
  confidence: number,
): RuleFinding {
  return {
    ruleId,
    analyzerKind: "rule-based",
    category: "policy-violation",
    severity,
    confidence,
    explanation: {
      what: "test",
      whyItMatters: "test",
      ruleId,
      ruleVersion: RULE_SET_VERSION,
    },
    evidence: { evidenceId: "ev-x", category: "tool-call-log", digest: "x" },
  };
}

describe("scoring", () => {
  it("returns null when there is nothing to score", () => {
    expect(scoreFindings([])).toBeNull();
  });

  it("produces bounded integer scores with explainable factors", () => {
    const score = scoreFindings([finding("r1", "high", 85)])!;
    expect(score.score).toBe(50);
    expect(score.severity).toBe("high");
    expect(score.confidence).toBe(85);
    expect(score.factors).toHaveLength(1);
    expect(score.factors[0]).toMatchObject({
      ruleId: "r1",
      severityPoints: 50,
      contribution: 50,
    });
    expect(Number.isInteger(score.score)).toBe(true);
  });

  it("adds breadth for additional findings and caps at 100", () => {
    const two = scoreFindings([
      finding("r1", "high", 80),
      finding("r2", "medium", 70),
    ])!;
    expect(two.score).toBe(55);
    expect(two.severity).toBe("high");
    expect(two.factors.map((f) => f.contribution)).toEqual([50, 5]);
    const many = scoreFindings(
      Array.from({ length: 20 }, (_, i) => finding(`r${i}`, "critical", 90)),
    )!;
    expect(many.score).toBe(100);
    expect(many.score).toBeLessThanOrEqual(100);
  });

  it("keeps severity and confidence independent", () => {
    // High confidence on a low-severity finding stays low severity.
    const low = scoreFindings([finding("r1", "low", 99)])!;
    expect(low.severity).toBe("low");
    expect(low.confidence).toBe(99);
    expect(low.score).toBe(SEVERITY_POINTS.low);
  });

  it("is deterministic across repeated scoring", () => {
    const input = [finding("r1", "critical", 90), finding("r2", "low", 40)];
    expect(scoreFindings(input)).toEqual(scoreFindings(input));
  });
});
