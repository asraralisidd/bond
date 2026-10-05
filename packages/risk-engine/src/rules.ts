/**
 * Deterministic rule-based analyzers (RULE_SET v1).
 *
 * Every analyzer here is RULE-BASED: pure functions over normalized
 * activity. Nothing here is an ML/LLM model, and nothing pretends to be.
 * Future ML/LLM analysis plugs into the `ActivityAnalyzer` interface
 * (see `behavioral-anomaly` placeholder) without touching the engine.
 *
 * Confidence convention (integer 0–100 internally, independent of
 * severity): deterministic per rule from input properties. Severity and
 * confidence are INDEPENDENT dimensions — high confidence never implies
 * high severity.
 */
import type { RiskCategory, RiskSeverity } from "@bond/shared-types";
import type { EngineEvidence } from "./evidence.js";
import type { NormalizedActivity } from "./input.js";
import { RULE_SET_VERSION } from "./versions.js";

export type AnalyzerKind = "rule-based" | "ml-placeholder";

export interface RuleExplanation {
  /** What was detected (one sentence, specific). */
  readonly what: string;
  /** Why it matters for the bond/operator (one sentence, specific). */
  readonly whyItMatters: string;
  /** Rule that fired, with version. */
  readonly ruleId: string;
  readonly ruleVersion: typeof RULE_SET_VERSION;
}

export interface RuleFinding {
  readonly ruleId: string;
  readonly analyzerKind: AnalyzerKind;
  readonly category: RiskCategory;
  readonly severity: RiskSeverity;
  /** Integer 0–100. Independent of severity. */
  readonly confidence: number;
  readonly explanation: RuleExplanation;
  readonly evidence: EngineEvidence;
}

export interface ActivityAnalyzer {
  readonly id: string;
  readonly version: typeof RULE_SET_VERSION;
  readonly kind: AnalyzerKind;
  readonly categories: readonly RiskCategory[];
  analyze(
    activity: NormalizedActivity,
    evidence: EngineEvidence,
  ): readonly RuleFinding[];
}

function finding(
  ruleId: string,
  kind: AnalyzerKind,
  category: RiskCategory,
  severity: RiskSeverity,
  confidence: number,
  what: string,
  whyItMatters: string,
  evidence: EngineEvidence,
): RuleFinding {
  return {
    ruleId,
    analyzerKind: kind,
    category,
    severity,
    confidence,
    explanation: {
      what,
      whyItMatters,
      ruleId,
      ruleVersion: RULE_SET_VERSION,
    },
    evidence,
  };
}

function isDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

/** Rule 1: action outside the policy allowlist → unauthorized-action/high. */
export const undeclaredActionAnalyzer: ActivityAnalyzer = {
  id: "undeclared-action",
  version: RULE_SET_VERSION,
  kind: "rule-based",
  categories: ["unauthorized-action"],
  analyze(activity, evidence) {
    const allowed = activity.policyContext.allowedActions;
    if (allowed === null || allowed.includes(activity.action)) {
      return [];
    }
    return [
      finding(
        "undeclared-action",
        "rule-based",
        "unauthorized-action",
        "high",
        85,
        `Agent performed action "${activity.action}" which is not in the policy allowlist (${allowed.length} allowed).`,
        "Allowlisted actions bound what the bond covers; off-allowlist actions are uninsured behavior.",
        evidence,
      ),
    ];
  },
};

/** Rule 2: tool outside declared tools → capability-mismatch/medium. */
export const undeclaredToolAnalyzer: ActivityAnalyzer = {
  id: "undeclared-tool",
  version: RULE_SET_VERSION,
  kind: "rule-based",
  categories: ["capability-mismatch"],
  analyze(activity, evidence) {
    const declared = activity.policyContext.declaredTools;
    if (activity.tool === null || declared === null) {
      return [];
    }
    if (declared.includes(activity.tool)) {
      return [];
    }
    return [
      finding(
        "undeclared-tool",
        "rule-based",
        "capability-mismatch",
        "medium",
        75,
        `Agent used tool "${activity.tool}" which was not declared at registration.`,
        "Declared capabilities define expected behavior; undeclared tools indicate scope drift.",
        evidence,
      ),
    ];
  },
};

/** Rule 3: spend over limit → overspend, severity by BigInt ratio tiers. */
export const spendLimitAnalyzer: ActivityAnalyzer = {
  id: "spend-limit-breach",
  version: RULE_SET_VERSION,
  kind: "rule-based",
  categories: ["overspend"],
  analyze(activity, evidence) {
    const { amountMinorUnits, policyContext } = activity;
    const limit = policyContext.spendLimitMinorUnits;
    if (amountMinorUnits === null || limit === null) {
      return [];
    }
    if (!isDigits(amountMinorUnits) || !isDigits(limit)) {
      return [];
    }
    const amount = BigInt(amountMinorUnits);
    const limitValue = BigInt(limit);
    if (amount <= limitValue || limitValue === 0n) {
      return [];
    }
    const ratio = amount / limitValue;
    const severity: RiskSeverity =
      ratio >= 10n ? "critical" : ratio >= 2n ? "high" : "medium";
    const confidence = ratio >= 10n ? 90 : ratio >= 2n ? 85 : 80;
    return [
      finding(
        "spend-limit-breach",
        "rule-based",
        "overspend",
        severity,
        confidence,
        `Agent spent ${amountMinorUnits} against a limit of ${limit} (×${ratio.toString()} over).`,
        "Overspend directly consumes bonded value beyond the agreed limit.",
        evidence,
      ),
    ];
  },
};

/**
 * Rule 4: large outbound transfer/message to an external destination →
 * data-exfil/medium. HEURISTIC placeholder: volume alone cannot prove
 * exfiltration; confidence is capped and the explanation says so.
 */
export const externalVolumeAnalyzer: ActivityAnalyzer = {
  id: "external-transfer-volume",
  version: RULE_SET_VERSION,
  kind: "rule-based",
  categories: ["data-exfil"],
  analyze(activity, evidence) {
    if (!activity.externalDestination || activity.bytesOut === null) {
      return [];
    }
    const threshold = activity.policyContext.exfilThresholdBytes ?? 1048576;
    if (activity.bytesOut <= threshold) {
      return [];
    }
    return [
      finding(
        "external-transfer-volume",
        "rule-based",
        "data-exfil",
        "medium",
        55,
        `Agent sent ${activity.bytesOut} bytes to an external destination (threshold ${threshold}).`,
        "Large external transfers MAY indicate exfiltration; volume alone is not proof — heuristic only, needs review.",
        evidence,
      ),
    ];
  },
};

/** Rule 5: action on the policy denylist → policy-violation/high. */
export const denylistAnalyzer: ActivityAnalyzer = {
  id: "policy-denylist",
  version: RULE_SET_VERSION,
  kind: "rule-based",
  categories: ["policy-violation"],
  analyze(activity, evidence) {
    const denied = activity.policyContext.denylistedActions;
    if (denied === null || !denied.includes(activity.action)) {
      return [];
    }
    return [
      finding(
        "policy-denylist",
        "rule-based",
        "policy-violation",
        "high",
        90,
        `Agent performed denylisted action "${activity.action}".`,
        "Denylisted actions are explicitly forbidden by the active policy.",
        evidence,
      ),
    ];
  },
};

/** Rule 6: third-party report → external-report, confidence capped at 60. */
export const reporterAnalyzer: ActivityAnalyzer = {
  id: "reporter-escalation",
  version: RULE_SET_VERSION,
  kind: "rule-based",
  categories: ["external-report"],
  analyze(activity, evidence) {
    if (activity.actionType !== "external-report") {
      return [];
    }
    const reported = activity.reporterSeverity ?? "medium";
    const severity: RiskSeverity =
      reported === "critical" || reported === "high" ? "high" : reported;
    return [
      finding(
        "reporter-escalation",
        "rule-based",
        "external-report",
        severity,
        60,
        `Third party reported "${activity.action}" at severity ${reported}.`,
        "External reports are unverified claims; confidence is capped until attested.",
        evidence,
      ),
    ];
  },
};

/**
 * Rule 7: behavioral anomaly — ML PLACEHOLDER. Always returns no findings.
 * Exists to pin the `ActivityAnalyzer` integration contract that a future
 * ML/LLM classifier will implement. Deterministic by construction.
 */
export const behavioralAnomalyPlaceholder: ActivityAnalyzer = {
  id: "behavioral-anomaly",
  version: RULE_SET_VERSION,
  kind: "ml-placeholder",
  categories: ["anomalous-behavior"],
  analyze(_activity, _evidence) {
    return [];
  },
};

/** The default v1 analyzer set, in stable evaluation order. */
export const DEFAULT_ANALYZERS: readonly ActivityAnalyzer[] = [
  undeclaredActionAnalyzer,
  undeclaredToolAnalyzer,
  spendLimitAnalyzer,
  externalVolumeAnalyzer,
  denylistAnalyzer,
  reporterAnalyzer,
  behavioralAnomalyPlaceholder,
];

/** Runs analyzers in order, concatenating findings deterministically. */
export function evaluateRules(
  activity: NormalizedActivity,
  evidence: EngineEvidence,
  analyzers: readonly ActivityAnalyzer[] = DEFAULT_ANALYZERS,
): readonly RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const analyzer of analyzers) {
    findings.push(...analyzer.analyze(activity, evidence));
  }
  return findings;
}
