import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { evaluateIndependently } from "./evaluator.js";
import {
  FULL_EVIDENCE,
  NO_EVIDENCE,
  NOW,
  flagWithStatusForTest,
  lenientProfile,
  makeFlag,
  standardProfile,
  strictProfile,
} from "./fixtures.js";

describe("independent evaluation", () => {
  it("approves evidence-backed high-confidence findings", () => {
    const evaluation = evaluateIndependently(
      standardProfile("attestor-a", "Org A"),
      makeFlag(),
      FULL_EVIDENCE,
      NOW,
    );
    expect(evaluation.outcome).toBe("approve");
    expect(evaluation.verdict).toBe("confirm");
    expect(evaluation.evidenceComplete).toBe(true);
    expect(evaluation.reason.length).toBeGreaterThan(0);
  });

  it("rejects weak findings and abstains without evidence", () => {
    const weak = evaluateIndependently(
      standardProfile("attestor-a", "Org A"),
      makeFlag({ severity: "high", confidence: 0.4 }),
      FULL_EVIDENCE,
      NOW,
    );
    expect(weak.outcome).toBe("reject");
    const blind = evaluateIndependently(
      standardProfile("attestor-a", "Org A"),
      makeFlag(),
      NO_EVIDENCE,
      NOW,
    );
    expect(blind.outcome).toBe("abstain");
    expect(blind.evidenceComplete).toBe(false);
  });

  it("abstains on borderline and below-grade findings instead of forcing", () => {
    // medium 0.8 vs standard threshold 0.85 → borderline abstain.
    const borderline = evaluateIndependently(
      standardProfile("attestor-a", "Org A"),
      makeFlag({ severity: "medium", confidence: 0.8 }),
      FULL_EVIDENCE,
      NOW,
    );
    expect(borderline.outcome).toBe("abstain");
    // low severity never forces a verdict.
    const low = evaluateIndependently(
      lenientProfile("attestor-c", "Org C"),
      makeFlag({ severity: "low", confidence: 0.99 }),
      FULL_EVIDENCE,
      NOW,
    );
    expect(low.outcome).toBe("abstain");
  });

  it("lets attestor B disagree with attestor A on the same flag", () => {
    const flag = makeFlag({ severity: "medium", confidence: 0.8 });
    const a = evaluateIndependently(
      standardProfile("attestor-a", "Org A"),
      flag,
      FULL_EVIDENCE,
      NOW,
    );
    const c = evaluateIndependently(
      lenientProfile("attestor-c", "Org C"),
      flag,
      FULL_EVIDENCE,
      NOW,
    );
    expect(a.outcome).toBe("abstain");
    expect(c.outcome).toBe("approve");
    expect(a.verdict).not.toBe(c.verdict);
  });

  it("refuses to evaluate non-actionable flags and is deterministic", () => {
    const dismissed = flagWithStatusForTest(makeFlag(), "dismissed");
    expect(() =>
      evaluateIndependently(
        standardProfile("attestor-a", "Org A"),
        dismissed,
        FULL_EVIDENCE,
        NOW,
      ),
    ).toThrowError(DomainError);
    const flag = makeFlag();
    const first = evaluateIndependently(
      strictProfile("attestor-b", "Org B"),
      flag,
      FULL_EVIDENCE,
      NOW,
    );
    const second = evaluateIndependently(
      strictProfile("attestor-b", "Org B"),
      flag,
      FULL_EVIDENCE,
      NOW,
    );
    expect(first).toEqual(second);
  });
});
