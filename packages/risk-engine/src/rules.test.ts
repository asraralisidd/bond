import { describe, expect, it } from "vitest";
import { normalizeActivity } from "./input.js";
import type { NormalizedActivity, RawActivityInput } from "./input.js";
import { deriveEvidence } from "./evidence.js";
import {
  DEFAULT_ANALYZERS,
  behavioralAnomalyPlaceholder,
  denylistAnalyzer,
  evaluateRules,
  externalVolumeAnalyzer,
  reporterAnalyzer,
  spendLimitAnalyzer,
  undeclaredActionAnalyzer,
  undeclaredToolAnalyzer,
} from "./rules.js";

function activity(
  overrides: Partial<RawActivityInput> = {},
): NormalizedActivity {
  return normalizeActivity({
    activityId: "act-001",
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
    ...overrides,
  });
}

function evidenceFor(act: NormalizedActivity) {
  return deriveEvidence(act);
}

describe("rules", () => {
  it("each rule fires on applicable input with expected severity/confidence", () => {
    const cases = [
      {
        analyzer: undeclaredActionAnalyzer,
        act: activity({ action: "delete-db" }),
        category: "unauthorized-action",
        severity: "high",
      },
      {
        analyzer: undeclaredToolAnalyzer,
        act: activity({ tool: "shell-exec" }),
        category: "capability-mismatch",
        severity: "medium",
      },
      {
        analyzer: spendLimitAnalyzer,
        act: activity({
          actionType: "transfer",
          action: "pay-vendor",
          amountMinorUnits: "5000",
          policyContext: {
            policyVersion: "policy v3",
            spendLimitMinorUnits: "1000",
          },
        }),
        category: "overspend",
        severity: "high",
      },
      {
        analyzer: externalVolumeAnalyzer,
        act: activity({
          actionType: "transfer",
          externalDestination: true,
          bytesOut: 5_000_000,
        }),
        category: "data-exfil",
        severity: "medium",
      },
      {
        analyzer: denylistAnalyzer,
        act: activity({
          action: "export-keys",
          policyContext: {
            policyVersion: "policy v3",
            denylistedActions: ["export-keys"],
          },
        }),
        category: "policy-violation",
        severity: "high",
      },
      {
        analyzer: reporterAnalyzer,
        act: activity({
          actionType: "external-report",
          action: "user-complaint",
          reporterSeverity: "critical",
          policyContext: { policyVersion: "policy v3" },
        }),
        category: "external-report",
        severity: "high",
      },
    ] as const;
    for (const { analyzer, act, category, severity } of cases) {
      const findings = analyzer.analyze(act, evidenceFor(act));
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe(category);
      expect(findings[0].severity).toBe(severity);
      expect(findings[0].analyzerKind).toBe("rule-based");
      // Every finding carries a structured explanation + evidence.
      expect(findings[0].explanation.what.length).toBeGreaterThan(0);
      expect(findings[0].explanation.whyItMatters.length).toBeGreaterThan(0);
      expect(findings[0].explanation.ruleId).toBe(analyzer.id);
      expect(findings[0].evidence.digest.length).toBeGreaterThan(0);
    }
  });

  it("rules stay silent when not applicable", () => {
    const clean = activity();
    for (const analyzer of [
      undeclaredActionAnalyzer,
      undeclaredToolAnalyzer,
      spendLimitAnalyzer,
      externalVolumeAnalyzer,
      denylistAnalyzer,
      reporterAnalyzer,
    ]) {
      expect(analyzer.analyze(clean, evidenceFor(clean))).toEqual([]);
    }
    // No policy context for a rule → rule abstains, never guesses.
    const noPolicy = activity({
      policyContext: { policyVersion: "policy v3" },
    });
    expect(
      undeclaredActionAnalyzer.analyze(noPolicy, evidenceFor(noPolicy)),
    ).toEqual([]);
  });

  it("spend tiers scale severity without float math", () => {
    const at = (amount: string, limit: string) =>
      spendLimitAnalyzer.analyze(
        activity({
          amountMinorUnits: amount,
          policyContext: {
            policyVersion: "policy v3",
            spendLimitMinorUnits: limit,
          },
        }),
        evidenceFor(activity()),
      );
    expect(at("1000", "1000")).toEqual([]);
    expect(at("1500", "1000")[0].severity).toBe("medium");
    expect(at("2000", "1000")[0].severity).toBe("high");
    expect(at("10000", "1000")[0].severity).toBe("critical");
  });

  it("ml placeholder is deterministic, empty, and honestly labeled", () => {
    const act = activity();
    expect(behavioralAnomalyPlaceholder.analyze(act, evidenceFor(act))).toEqual(
      [],
    );
    expect(behavioralAnomalyPlaceholder.kind).toBe("ml-placeholder");
    expect(behavioralAnomalyPlaceholder.categories).toEqual([
      "anomalous-behavior",
    ]);
  });

  it("default set evaluates in stable order and covers six live categories", () => {
    expect(DEFAULT_ANALYZERS.map((a) => a.id)).toEqual([
      "undeclared-action",
      "undeclared-tool",
      "spend-limit-breach",
      "external-transfer-volume",
      "policy-denylist",
      "reporter-escalation",
      "behavioral-anomaly",
    ]);
    const hostile = activity({
      action: "export-keys",
      tool: "shell-exec",
      policyContext: {
        policyVersion: "policy v3",
        allowedActions: ["read-file"],
        declaredTools: ["fs-read"],
        denylistedActions: ["export-keys"],
      },
    });
    const findings = evaluateRules(hostile, evidenceFor(hostile));
    expect(findings.map((f) => f.ruleId)).toEqual([
      "undeclared-action",
      "undeclared-tool",
      "policy-denylist",
    ]);
  });
});
