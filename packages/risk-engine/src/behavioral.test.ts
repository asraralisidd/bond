/**
 * Phase 20 behavioral detector tests.
 *
 * Covers: threshold resolution (defaults, validation, rejection),
 * each detector (quiet/no-fire, exact threshold, just-over, window
 * boundaries, determinism, explanation content), scoring-v2
 * (v1 frozen, capped breadth, no critical), version stamps, and
 * secret/metadata hygiene.
 */
import { describe, expect, it } from "vitest";
import type { RiskCategory } from "@bond/shared-types";
import { normalizeActivity } from "./input.js";
import type {
  BehavioralThresholdsInput,
  NormalizedActivity,
  RawActivityInput,
} from "./input.js";
import { deriveEvidence } from "./evidence.js";
import {
  BEHAVIORAL_RULE_IDS,
  DEFAULT_BEHAVIORAL_THRESHOLDS,
  detectActivityBurst,
  detectNovelTool,
  detectRepeatViolation,
  detectSpendVelocity,
  evaluateBehavioral,
  resolveBehavioralThresholds,
} from "./behavioral.js";
import type {
  BehavioralHistory,
  LedgerActivityEntry,
  PriorFlagEntry,
} from "./behavioral.js";
import { scoreFindings, scoreWithBehavioral } from "./scoring.js";
import { evaluateRules } from "./rules.js";
import { RULE_SET_V2, SCORING_V2 } from "./versions.js";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const MIN = 60_000;

function activity(
  overrides: Partial<RawActivityInput> = {},
): NormalizedActivity {
  return normalizeActivity({
    activityId: "act-b-001",
    agentId: "agent-001",
    occurredAt: "2026-10-07T12:00:00.000Z",
    actionType: "transfer",
    action: "pay-vendor",
    tool: "transfers",
    amountMinorUnits: "100",
    policyContext: {
      policyVersion: "bond-policy-v1",
      allowedActions: ["pay-vendor"],
      declaredTools: ["transfers"],
      spendLimitMinorUnits: "1000",
    },
    ...overrides,
  });
}

function entry(
  overrides: Partial<LedgerActivityEntry> = {},
): LedgerActivityEntry {
  return {
    analysisId: "analysis-x",
    action: "pay-vendor",
    tool: "transfers",
    amountMinorUnits: "100",
    createdAtMs: NOW - 30 * MIN,
    ...overrides,
  };
}

function currentEntry(): LedgerActivityEntry {
  return {
    analysisId: "analysis-current",
    action: "pay-vendor",
    tool: "transfers",
    amountMinorUnits: "100",
    createdAtMs: NOW,
  };
}

function historyWith(
  entries: LedgerActivityEntry[],
  priorFlags: PriorFlagEntry[] = [],
): BehavioralHistory {
  return { entries, priorFlags };
}

function priorFlag(
  category: RiskCategory,
  minutesAgo: number,
  status = "open",
): PriorFlagEntry {
  return { category, status, createdAtMs: NOW - minutesAgo * MIN };
}

describe("threshold resolution", () => {
  it("applies safe defaults when absent", () => {
    expect(resolveBehavioralThresholds(undefined)).toEqual(
      DEFAULT_BEHAVIORAL_THRESHOLDS,
    );
    expect(DEFAULT_BEHAVIORAL_THRESHOLDS).toEqual({
      windowHours: 1,
      burstCount: 10,
      velocityMultiple: 3,
      baselineDays: 7,
      repeatCount: 3,
      repeatWindowHours: 24,
    });
  });

  it("accepts explicit valid thresholds", () => {
    const resolved = resolveBehavioralThresholds({
      windowHours: 2,
      burstCount: 5,
      velocityMultiple: 2,
      baselineDays: 1,
      repeatCount: 2,
      repeatWindowHours: 48,
    });
    expect(resolved.burstCount).toBe(5);
    expect(resolved.repeatWindowHours).toBe(48);
  });

  it("rejects non-integer, out-of-range, and non-object thresholds", () => {
    const badCases: unknown[] = [
      { burstCount: 1 },
      { burstCount: 1001 },
      { burstCount: 2.5 },
      { burstCount: "10" },
      { windowHours: 0 },
      { windowHours: 169 },
      { velocityMultiple: 1 },
      { baselineDays: 31 },
      { repeatCount: 21 },
      { repeatWindowHours: 0 },
    ];
    for (const bad of badCases) {
      let code: string | null = null;
      try {
        resolveBehavioralThresholds(bad as BehavioralThresholdsInput);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("INVALID_ACTIVITY_INPUT");
    }
    let objectCode: string | null = null;
    try {
      resolveBehavioralThresholds("nope" as never);
    } catch (error) {
      objectCode = (error as { code?: string }).code ?? null;
    }
    expect(objectCode).toBe("INVALID_ACTIVITY_INPUT");
  });

  it("normalization always resolves thresholds", () => {
    expect(activity().policyContext.behavioralThresholds).toEqual(
      DEFAULT_BEHAVIORAL_THRESHOLDS,
    );
    const custom = activity({
      policyContext: {
        policyVersion: "bond-policy-v1",
        behavioralThresholds: { burstCount: 4 },
      },
    });
    expect(custom.policyContext.behavioralThresholds.burstCount).toBe(4);
    expect(custom.policyContext.behavioralThresholds.windowHours).toBe(1);
  });
});

describe("activity-burst", () => {
  const t = DEFAULT_BEHAVIORAL_THRESHOLDS;

  it("stays quiet under the threshold", () => {
    const act = activity();
    // 1 current + 9 history = 10, exactly at default limit 10.
    const entries = Array.from({ length: 9 }, (_, i) =>
      entry({ analysisId: `a-${i}` }),
    );
    expect(
      detectActivityBurst(deriveEvidence(act), historyWith(entries), t, NOW),
    ).toEqual([]);
  });

  it("fires just over the threshold with medium severity", () => {
    const act = activity();
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ analysisId: `a-${i}` }),
    );
    const findings = detectActivityBurst(
      deriveEvidence(act),
      historyWith(entries),
      t,
      NOW,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("activity-burst");
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.category).toBe("anomalous-behavior");
    expect(findings[0]?.explanation.what).toBe(
      "11 analyses in 60 minutes vs limit 10.",
    );
    expect(findings[0]?.explanation.ruleVersion).toBe(RULE_SET_V2);
  });

  it("escalates to high at 3x threshold but never critical", () => {
    const act = activity();
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry({ analysisId: `a-${i}` }),
    );
    const findings = detectActivityBurst(
      deriveEvidence(act),
      historyWith(entries),
      t,
      NOW,
    );
    expect(findings[0]?.severity).toBe("high");
  });

  it("ignores entries outside the window", () => {
    const act = activity();
    const stale = Array.from({ length: 50 }, (_, i) =>
      entry({ analysisId: `old-${i}`, createdAtMs: NOW - 120 * MIN }),
    );
    // 50 stale entries alone: outside the 60-min window, no fire.
    expect(
      detectActivityBurst(deriveEvidence(act), historyWith(stale), t, NOW),
    ).toEqual([]);
    // 9 fresh + 50 stale = 10 in-window: exactly at limit, no fire.
    const fresh = Array.from({ length: 9 }, (_, i) =>
      entry({ analysisId: `a-${i}` }),
    );
    expect(
      detectActivityBurst(
        deriveEvidence(act),
        historyWith([...fresh, ...stale]),
        t,
        NOW,
      ),
    ).toEqual([]);
  });

  it("is deterministic", () => {
    const act = activity();
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ analysisId: `a-${i}` }),
    );
    const h = historyWith(entries);
    const ev = deriveEvidence(act);
    expect(detectActivityBurst(ev, h, t, NOW)).toEqual(
      detectActivityBurst(ev, h, t, NOW),
    );
  });
});

describe("spend-velocity", () => {
  const t = DEFAULT_BEHAVIORAL_THRESHOLDS;

  it("stays quiet without a limit or without amounts", () => {
    const noLimit = activity({
      policyContext: { policyVersion: "bond-policy-v1" },
    });
    expect(
      detectSpendVelocity(
        noLimit,
        deriveEvidence(noLimit),
        currentEntry(),
        historyWith([entry()]),
        t,
        NOW,
      ),
    ).toEqual([]);
    const act = activity({ amountMinorUnits: undefined });
    expect(
      detectSpendVelocity(
        act,
        deriveEvidence(act),
        { ...currentEntry(), amountMinorUnits: null },
        historyWith([]),
        t,
        NOW,
      ),
    ).toEqual([]);
  });

  it("fires medium just over allowance, high at 3x", () => {
    // Limit 1000, multiple 3 → allowance 3000. Current 100.
    const act = activity();
    const medium = historyWith([
      entry({ analysisId: "m-1", amountMinorUnits: "1500" }),
      entry({ analysisId: "m-2", amountMinorUnits: "1500" }),
    ]);
    const mf = detectSpendVelocity(
      act,
      deriveEvidence(act),
      currentEntry(),
      medium,
      t,
      NOW,
    );
    expect(mf).toHaveLength(1);
    expect(mf[0]?.severity).toBe("medium");
    expect(mf[0]?.explanation.what).toContain("3100 minor units");
    expect(mf[0]?.explanation.what).toContain("×1 over");

    const high = historyWith([
      entry({ analysisId: "h-1", amountMinorUnits: "5000" }),
      entry({ analysisId: "h-2", amountMinorUnits: "5000" }),
    ]);
    const hf = detectSpendVelocity(
      act,
      deriveEvidence(act),
      currentEntry(),
      high,
      t,
      NOW,
    );
    expect(hf[0]?.severity).toBe("high");
  });

  it("uses integer arithmetic and ignores non-numeric amounts", () => {
    const act = activity();
    const findings = detectSpendVelocity(
      act,
      deriveEvidence(act),
      currentEntry(),
      historyWith([
        entry({ analysisId: "x-1", amountMinorUnits: "not-a-number" }),
        entry({ analysisId: "x-2", amountMinorUnits: "12.5" }),
      ]),
      t,
      NOW,
    );
    expect(findings).toEqual([]);
  });
});

describe("novel-tool", () => {
  const t = DEFAULT_BEHAVIORAL_THRESHOLDS;

  it("stays quiet without a tool, with known tools, or thin baselines", () => {
    const noTool = activity({ tool: undefined });
    expect(
      detectNovelTool(
        noTool,
        deriveEvidence(noTool),
        historyWith([entry(), entry(), entry()]),
        t,
        NOW,
      ),
    ).toEqual([]);
    // Known tool.
    const act = activity();
    expect(
      detectNovelTool(
        act,
        deriveEvidence(act),
        historyWith([entry(), entry(), entry()]),
        t,
        NOW,
      ),
    ).toEqual([]);
    // Thin baseline (< 3 rows): new agent guard.
    const novel = activity({ tool: "brand-new-tool" });
    expect(
      detectNovelTool(
        novel,
        deriveEvidence(novel),
        historyWith([entry(), entry()]),
        t,
        NOW,
      ),
    ).toEqual([]);
  });

  it("fires low severity for first-seen tools with sufficient baseline", () => {
    const novel = activity({ tool: "shell-exec" });
    const findings = detectNovelTool(
      novel,
      deriveEvidence(novel),
      historyWith([entry(), entry(), entry(), entry()]),
      t,
      NOW,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("novel-tool");
    expect(findings[0]?.severity).toBe("low");
    expect(findings[0]?.category).toBe("capability-mismatch");
    expect(findings[0]?.explanation.what).toContain('"shell-exec"');
    expect(findings[0]?.explanation.what).toContain("7-day baseline");
  });
});

describe("repeat-violation", () => {
  const t = DEFAULT_BEHAVIORAL_THRESHOLDS;

  it("stays quiet below the repeat count", () => {
    const act = activity();
    const findings = detectRepeatViolation(
      deriveEvidence(act),
      historyWith([], [priorFlag("overspend", 60)]),
      ["overspend"],
      t,
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("fires high at the repeat count, ignoring dismissed/expired", () => {
    const act = activity();
    const flags: PriorFlagEntry[] = [
      priorFlag("overspend", 60),
      priorFlag("overspend", 120),
      priorFlag("overspend", 180, "dismissed"),
      priorFlag("overspend", 240, "expired"),
      priorFlag("unauthorized-action", 60),
    ];
    const findings = detectRepeatViolation(
      deriveEvidence(act),
      historyWith([], flags),
      ["overspend", "unauthorized-action"],
      t,
      NOW,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("repeat-violation");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.category).toBe("overspend");
    expect(findings[0]?.explanation.what).toBe(
      "3 overspend findings in 24 hours (including this one) vs repeat limit 3.",
    );
  });

  it("ignores flags outside the window", () => {
    const act = activity();
    const findings = detectRepeatViolation(
      deriveEvidence(act),
      historyWith(
        [],
        [priorFlag("overspend", 60), priorFlag("overspend", 25 * 60)],
      ),
      ["overspend"],
      t,
      NOW,
    );
    expect(findings).toEqual([]);
  });
});

describe("evaluateBehavioral + scoring-v2", () => {
  it("returns nothing on quiet history; scoring passes v1 through", () => {
    const calm = activity({
      amountMinorUnits: "100",
      policyContext: {
        policyVersion: "bond-policy-v1",
        allowedActions: ["pay-vendor"],
        declaredTools: ["transfers"],
        spendLimitMinorUnits: "1000000",
      },
    });
    const findings = evaluateBehavioral(
      calm,
      deriveEvidence(calm),
      currentEntry(),
      historyWith([]),
      [],
      NOW,
    );
    expect(findings).toEqual([]);
    const v1score = scoreFindings(evaluateRules(calm, deriveEvidence(calm)));
    expect(scoreWithBehavioral(v1score, findings)).toBe(v1score);
  });

  it("v1 scoring is frozen: identical input, identical output", () => {
    const act = activity({ amountMinorUnits: "5000" });
    const first = scoreFindings(evaluateRules(act, deriveEvidence(act)));
    const second = scoreFindings(evaluateRules(act, deriveEvidence(act)));
    expect(first).toEqual(second);
    expect(first?.scoringVersion).toBe("scoring-v1");
    expect(first?.score).toBe(50);
  });

  it("v2 preserves the v1 floor, caps breadth, stamps v2", () => {
    // Denylisted action → v1 policy-denylist/high (50 pts). Small
    // amounts keep velocity quiet so only burst fires behaviorally.
    const act = activity({
      action: "self-transfer",
      policyContext: {
        policyVersion: "bond-policy-v1",
        allowedActions: ["pay-vendor", "self-transfer"],
        declaredTools: ["transfers"],
        denylistedActions: ["self-transfer"],
        spendLimitMinorUnits: "1000",
      },
    });
    const ev = deriveEvidence(act);
    const v1 = scoreFindings(evaluateRules(act, deriveEvidence(act)));
    expect(v1?.score).toBe(50);
    const behavioral = evaluateBehavioral(
      act,
      ev,
      currentEntry(),
      historyWith(
        Array.from({ length: 12 }, (_, i) => entry({ analysisId: `b-${i}` })),
      ),
      [],
      NOW,
    );
    expect(behavioral.length).toBeGreaterThan(0);
    const v2 = scoreWithBehavioral(v1, behavioral);
    expect(v2?.scoringVersion).toBe(SCORING_V2);
    expect(v2!.score).toBeGreaterThanOrEqual(50);
    // Single behavioral signal adds no breadth: max(50, 25) + 0.
    expect(v2!.score).toBe(50);
    expect(v2!.severity).toBe("high");
  });

  it("v2 breadth is capped at +8 with many behavioral signals", () => {
    const v2 = scoreWithBehavioral(null, [
      ...evaluateBehavioral(
        activity({ tool: "novel-a" }),
        deriveEvidence(activity({ tool: "novel-a" })),
        currentEntry(),
        historyWith([entry(), entry(), entry()]),
        [],
        NOW,
      ),
      ...Array.from({ length: 9 }, (_, i) => ({
        ruleId: "activity-burst",
        analyzerKind: "rule-based" as const,
        category: "anomalous-behavior" as const,
        severity: "medium" as const,
        confidence: 70,
        explanation: {
          what: `burst ${i}`,
          whyItMatters: "test",
          ruleId: "activity-burst",
          ruleVersion: RULE_SET_V2,
        },
        evidence: deriveEvidence(activity()),
      })),
    ]);
    expect(v2?.scoringVersion).toBe(SCORING_V2);
    // behavioralBase = 25 + 5×9 = 70; breadth = min(8, 2×9) = 8.
    expect(v2!.score).toBe(78);
  });

  it("behavioral rule ids are exactly the four detectors", () => {
    expect([...BEHAVIORAL_RULE_IDS]).toEqual([
      "activity-burst",
      "spend-velocity",
      "novel-tool",
      "repeat-violation",
    ]);
  });

  it("no behavioral finding ever reaches critical", () => {
    const act = activity();
    const ev = deriveEvidence(act);
    const huge = historyWith(
      Array.from({ length: 500 }, (_, i) =>
        entry({ analysisId: `z-${i}`, amountMinorUnits: "999999999999" }),
      ),
      Array.from({ length: 50 }, (_, i) =>
        priorFlag("overspend", 60 + i, "open"),
      ),
    );
    const findings = evaluateBehavioral(
      act,
      ev,
      { ...currentEntry(), amountMinorUnits: "999999999999" },
      huge,
      ["overspend", "unauthorized-action"],
      NOW,
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const item of findings) {
      expect(item.severity).not.toBe("critical");
    }
    const scored = scoreWithBehavioral(null, findings);
    expect(scored?.severity).not.toBe("critical");
  });

  it("never reads metadata or secrets", () => {
    const act = activity({
      metadata: { api_key: "sk-CANARY-001", note: "hello" },
      tool: "mystery-tool",
    });
    const findings = evaluateBehavioral(
      act,
      deriveEvidence(act),
      currentEntry(),
      historyWith([entry(), entry(), entry()]),
      [],
      NOW,
    );
    expect(JSON.stringify(findings)).not.toContain("sk-CANARY-001");
  });
});
