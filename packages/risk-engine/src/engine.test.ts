import { describe, expect, it } from "vitest";
import { analyzeActivity, analyzeBatch } from "./engine.js";
import type { RawActivityInput } from "./input.js";
import {
  ENGINE_VERSION,
  RULE_SET_VERSION,
  SCORING_MODEL_VERSION,
} from "./versions.js";

function benign(): RawActivityInput {
  return {
    activityId: "act-benign",
    agentId: "agent-001",
    occurredAt: "2026-10-01T12:00:00.000Z",
    actionType: "tool-call",
    action: "read-file",
    tool: "fs-read",
    policyContext: {
      policyVersion: "policy v3",
      allowedActions: ["read-file"],
      declaredTools: ["fs-read"],
    },
  };
}

function hostile(): RawActivityInput {
  return {
    activityId: "act-hostile",
    agentId: "agent-001",
    occurredAt: "2026-10-01T12:05:00.000Z",
    actionType: "transfer",
    action: "pay-vendor",
    tool: "shell-exec",
    amountMinorUnits: "50000",
    policyContext: {
      policyVersion: "policy v3",
      allowedActions: ["read-file"],
      declaredTools: ["fs-read"],
      spendLimitMinorUnits: "1000",
    },
  };
}

describe("risk engine", () => {
  it("returns no flags and null score for no-risk activity", () => {
    const result = analyzeActivity(benign(), { requestId: "req-1" });
    expect(result.flags).toEqual([]);
    expect(result.score).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.agentId).toBe("agent-001");
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.ruleSetVersion).toBe(RULE_SET_VERSION);
    expect(result.scoringVersion).toBe(SCORING_MODEL_VERSION);
    expect(result.logMetadata.agentId).toBe("agent-001");
    expect(result.logMetadata.requestId).toBe("req-1");
  });

  it("flags high-risk activity across multiple categories", () => {
    const result = analyzeActivity(hostile());
    const categories = result.flags.map((f) => f.category).sort();
    expect(categories).toEqual(
      ["capability-mismatch", "overspend", "unauthorized-action"].sort(),
    );
    // Flags are Phase 1 domain objects: validated, open, versioned.
    for (const flag of result.flags) {
      expect(flag.status).toBe("open");
      expect(flag.agentId).toBe("agent-001");
      expect(flag.detectedAt).toBe("2026-10-01T12:05:00.000Z");
      expect(flag.modelVersion).toContain(ENGINE_VERSION);
      expect(flag.evidenceRefs).toHaveLength(1);
    }
    expect(result.score).not.toBeNull();
    expect(result.score!.score).toBeGreaterThan(0);
    expect(result.score!.score).toBeLessThanOrEqual(100);
  });

  it("is deterministic: identical input reproduces identical output", () => {
    const a = analyzeActivity(hostile());
    const b = analyzeActivity(hostile());
    expect(a).toEqual(b);
    expect(a.analysisId).toBe(b.analysisId);
  });

  it("deduplicates repeated activity via seen keys", () => {
    const first = analyzeActivity(hostile());
    expect(first.skippedDuplicateKeys).toEqual([]);
    const repeat = analyzeActivity(hostile(), {
      seenKeys: new Set([first.analysisId.replace("analysis-", "")]),
    });
    // Same content key → skipped. Derive the key the engine uses:
    expect(repeat.flags).toEqual([]);
    expect(repeat.skippedDuplicateKeys).toHaveLength(1);
    expect(repeat.score).toBeNull();
  });

  it("batch analysis flags once and skips repeats", () => {
    const results = analyzeBatch([hostile(), hostile(), benign()]);
    expect(results).toHaveLength(3);
    expect(results[0].flags.length).toBeGreaterThan(0);
    expect(results[1].flags).toEqual([]);
    expect(results[1].skippedDuplicateKeys).toHaveLength(1);
    expect(results[2].flags).toEqual([]);
  });

  it("treats distinct activity as distinct", () => {
    const results = analyzeBatch([
      hostile(),
      { ...hostile(), activityId: "act-hostile-2" },
    ]);
    expect(results[0].flags.length).toBeGreaterThan(0);
    expect(results[1].flags.length).toBeGreaterThan(0);
    expect(results[0].analysisId).not.toBe(results[1].analysisId);
  });

  it("carries a full explanation chain on every finding", () => {
    const result = analyzeActivity(hostile());
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.explanation.what.length).toBeGreaterThan(0);
      expect(finding.explanation.whyItMatters.length).toBeGreaterThan(0);
      expect(finding.explanation.ruleVersion).toBe(RULE_SET_VERSION);
      expect(
        result.score!.factors.some((f) => f.ruleId === finding.ruleId),
      ).toBe(true);
    }
  });
});
