/**
 * Phase 21 event-sourced trust (reputation-v1) unit tests.
 *
 * Covers: trust bands, baseline, impact table ordering
 * (observed < attested < enforcement), clamping, dismissal and
 * clean-bond positives, validation, determinism, explanation shape,
 * and v0 regression (deriveReputation untouched).
 */
import { describe, expect, it } from "vitest";
import {
  REPUTATION_BASELINE_SCORE,
  REPUTATION_VERSION,
  applyReputationEvent,
  deriveReputation,
  impactForEvent,
  standingForScore,
  trustLevelForScore,
} from "./reputation.js";
import {
  parseAgentId,
  parseProtocolEventId,
  parseReputationId,
} from "./ids.js";

describe("trust levels", () => {
  it("maps the five bands with documented boundaries", () => {
    expect(trustLevelForScore(100)).toBe("VERY_HIGH");
    expect(trustLevelForScore(90)).toBe("VERY_HIGH");
    expect(trustLevelForScore(89)).toBe("HIGH");
    expect(trustLevelForScore(70)).toBe("HIGH");
    expect(trustLevelForScore(69)).toBe("MODERATE");
    expect(trustLevelForScore(50)).toBe("MODERATE");
    expect(trustLevelForScore(49)).toBe("LOW");
    expect(trustLevelForScore(25)).toBe("LOW");
    expect(trustLevelForScore(24)).toBe("VERY_LOW");
    expect(trustLevelForScore(0)).toBe("VERY_LOW");
  });

  it("nests inside v0 standing bands", () => {
    expect(standingForScore(95)).toBe("good");
    expect(standingForScore(75)).toBe("good");
    expect(standingForScore(60)).toBe("probation");
    expect(standingForScore(30)).toBe("poor");
    expect(REPUTATION_BASELINE_SCORE).toBe(75);
    expect(trustLevelForScore(REPUTATION_BASELINE_SCORE)).toBe("HIGH");
  });
});

describe("impact policy", () => {
  it("weights observed risk by severity", () => {
    expect(
      impactForEvent({ eventType: "risk_flag_observed", severity: "low" })
        .impact,
    ).toBe(-1);
    expect(
      impactForEvent({ eventType: "risk_flag_observed", severity: "medium" })
        .impact,
    ).toBe(-2);
    expect(
      impactForEvent({ eventType: "risk_flag_observed", severity: "high" })
        .impact,
    ).toBe(-5);
    expect(
      impactForEvent({
        eventType: "risk_flag_observed",
        severity: "critical",
      }).impact,
    ).toBe(-8);
  });

  it("weights attested violations strictly stronger than observations", () => {
    for (const severity of ["low", "medium", "high", "critical"] as const) {
      const observed = impactForEvent({
        eventType: "risk_flag_observed",
        severity,
      }).impact;
      const attested = impactForEvent({
        eventType: "attested_violation",
        severity,
      }).impact;
      expect(attested).toBeLessThan(observed);
    }
    expect(
      impactForEvent({ eventType: "attested_violation", severity: "high" })
        .impact,
    ).toBe(-12);
  });

  it("prices enforcement strongest and positives from verified outcomes", () => {
    expect(impactForEvent({ eventType: "slash_enforced" }).impact).toBe(-15);
    expect(
      impactForEvent({ eventType: "slash_enforced", fullSlash: true }).impact,
    ).toBe(-30);
    expect(impactForEvent({ eventType: "attestation_dismissed" }).impact).toBe(
      2,
    );
    expect(impactForEvent({ eventType: "clean_bond_completed" }).impact).toBe(
      3,
    );
  });

  it("emits reason codes and human-readable reasons", () => {
    const observed = impactForEvent({
      eventType: "risk_flag_observed",
      severity: "high",
      category: "overspend",
    });
    expect(observed.reasonCode).toBe("OBSERVED_HIGH_RISK");
    expect(observed.reason).toContain("overspend");
    expect(observed.reason).toContain("not a confirmed violation");
    const attested = impactForEvent({
      eventType: "attested_violation",
      severity: "critical",
    });
    expect(attested.reasonCode).toBe("ATTESTED_CRITICAL_VIOLATION");
    expect(attested.reason).toContain("quorum");
  });

  it("rejects severity-weighted events without severity", () => {
    expect(() =>
      impactForEvent({ eventType: "risk_flag_observed" }),
    ).toThrowError(/requires a valid severity/);
    expect(() =>
      impactForEvent({
        eventType: "attested_violation",
        severity: "extreme" as never,
      }),
    ).toThrowError(/requires a valid severity/);
  });
});

describe("applyReputationEvent", () => {
  function apply(scoreBefore: number, extra: Record<string, unknown> = {}) {
    return applyReputationEvent({
      scoreBefore,
      eventType: "risk_flag_observed",
      sourceType: "risk_flag",
      sourceId: "rf-test-1",
      severity: "medium",
      ...extra,
    } as Parameters<typeof applyReputationEvent>[0]);
  }

  it("computes before/after with clamping", () => {
    expect(apply(75).scoreAfter).toBe(73);
    expect(
      apply(1, { eventType: "slash_enforced", fullSlash: true }).scoreAfter,
    ).toBe(0);
    expect(apply(99, { eventType: "clean_bond_completed" }).scoreAfter).toBe(
      100,
    );
  });

  it("returns the full explanation shape", () => {
    const out = applyReputationEvent({
      scoreBefore: 72,
      eventType: "attested_violation",
      sourceType: "attestation",
      sourceId: "att-1",
      severity: "high",
      category: "policy-violation",
    });
    expect(out).toMatchObject({
      eventType: "attested_violation",
      impact: -12,
      scoreBefore: 72,
      scoreAfter: 60,
      reasonCode: "ATTESTED_HIGH_VIOLATION",
      version: REPUTATION_VERSION,
    });
    expect(out.sourceType).toBe("attestation");
    expect(out.sourceId).toBe("att-1");
    expect(typeof out.reason).toBe("string");
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("validates score bounds and source ids", () => {
    expect(() => apply(101)).toThrowError(/\[0, 100\]/);
    expect(() => apply(-1)).toThrowError(/\[0, 100\]/);
    expect(() => apply(75.5)).toThrowError(/\[0, 100\]/);
    expect(() =>
      applyReputationEvent({
        scoreBefore: 75,
        eventType: "clean_bond_completed",
        sourceType: "bond",
        sourceId: "",
      }),
    ).toThrowError(/sourceId/);
  });

  it("is deterministic", () => {
    const input = {
      scoreBefore: 80,
      eventType: "slash_enforced" as const,
      sourceType: "slash_event" as const,
      sourceId: "sl-9",
      fullSlash: false,
    };
    expect(applyReputationEvent(input)).toEqual(applyReputationEvent(input));
  });
});

describe("v0 regression", () => {
  it("deriveReputation keeps v0 semantics and version", () => {
    const record = deriveReputation({
      reputationId: parseReputationId("rep-001"),
      agentId: parseAgentId("agent-001"),
      factors: {
        confirmedFlags: 1,
        partialSlashes: 0,
        fullSlashes: 0,
        cleanBondsCompleted: 0,
        remediatedResolutions: 0,
      },
      triggeredByEvent: parseProtocolEventId("ev-001"),
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(record.score).toBe(95);
    expect(record.modelVersion).toBe("v0");
    expect(record.standing).toBe("good");
  });
});
