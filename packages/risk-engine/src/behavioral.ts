/**
 * Deterministic behavioral detectors (RULE_SET v2, Phase 20).
 *
 * PURE FUNCTIONS ONLY: history arrives as explicit arguments. This
 * module never queries PostgreSQL, never reads the environment or the
 * wall clock, never uses randomness, never touches the network, and
 * never imports API, wallet, Midnight, attestor, or enforcement code.
 * Time is an explicit `nowMs` argument supplied by the caller (the
 * API service uses the analysis instant), so identical inputs always
 * yield identical outputs.
 *
 * Severity ceiling: behavioral findings NEVER exceed HIGH and NEVER
 * produce CRITICAL. Statistics alone must not create slash-grade
 * pressure — attestor quorum remains mandatory for enforcement.
 *
 * Windows use the caller-supplied timestamps, which the API layer
 * sources from server-written `created_at` (never client `occurredAt`).
 */
import { DomainError } from "@bond/shared-types";
import type { RiskCategory } from "@bond/shared-types";
import type { BehavioralThresholdsInput } from "./input.js";
import type { ResolvedBehavioralThresholds } from "./input.js";
import type { NormalizedActivity } from "./input.js";
import type { EngineEvidence } from "./evidence.js";
import type { RuleFinding } from "./rules.js";
import { RULE_SET_V2 } from "./versions.js";

export const BEHAVIORAL_RULE_IDS = [
  "activity-burst",
  "spend-velocity",
  "novel-tool",
  "repeat-violation",
] as const;

export type BehavioralRuleId = (typeof BEHAVIORAL_RULE_IDS)[number];

/** Safe defaults: explicit, documented, no hidden configuration. */
export const DEFAULT_BEHAVIORAL_THRESHOLDS: ResolvedBehavioralThresholds = {
  windowHours: 1,
  burstCount: 10,
  velocityMultiple: 3,
  baselineDays: 7,
  repeatCount: 3,
  repeatWindowHours: 24,
};

const MS_PER_HOUR = 3_600_000;

function requireIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DomainError(
      "INVALID_ACTIVITY_INPUT",
      `Invalid behavioral threshold: ${field} must be an integer`,
      { field, value },
    );
  }
  if (value < min || value > max) {
    throw new DomainError(
      "INVALID_ACTIVITY_INPUT",
      `Invalid behavioral threshold: ${field} must be ${min}–${max}`,
      { field, value },
    );
  }
  return value;
}

/**
 * Validates optional thresholds, applying safe defaults. Rejects
 * out-of-range values instead of silently accepting unsafe ones.
 * Throws INVALID_ACTIVITY_INPUT (400 at the API boundary).
 */
export function resolveBehavioralThresholds(
  raw: BehavioralThresholdsInput | undefined,
): ResolvedBehavioralThresholds {
  if (raw === undefined) {
    return { ...DEFAULT_BEHAVIORAL_THRESHOLDS };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DomainError(
      "INVALID_ACTIVITY_INPUT",
      "Invalid behavioral thresholds: must be an object",
      { value: raw },
    );
  }
  return {
    windowHours: requireIntInRange(
      raw.windowHours,
      "windowHours",
      1,
      168,
      DEFAULT_BEHAVIORAL_THRESHOLDS.windowHours,
    ),
    burstCount: requireIntInRange(
      raw.burstCount,
      "burstCount",
      2,
      1000,
      DEFAULT_BEHAVIORAL_THRESHOLDS.burstCount,
    ),
    velocityMultiple: requireIntInRange(
      raw.velocityMultiple,
      "velocityMultiple",
      2,
      100,
      DEFAULT_BEHAVIORAL_THRESHOLDS.velocityMultiple,
    ),
    baselineDays: requireIntInRange(
      raw.baselineDays,
      "baselineDays",
      1,
      30,
      DEFAULT_BEHAVIORAL_THRESHOLDS.baselineDays,
    ),
    repeatCount: requireIntInRange(
      raw.repeatCount,
      "repeatCount",
      2,
      20,
      DEFAULT_BEHAVIORAL_THRESHOLDS.repeatCount,
    ),
    repeatWindowHours: requireIntInRange(
      raw.repeatWindowHours,
      "repeatWindowHours",
      1,
      168,
      DEFAULT_BEHAVIORAL_THRESHOLDS.repeatWindowHours,
    ),
  };
}

/**
 * One server-written ledger row, as loaded by the API's bounded query.
 * Only the fields detectors need — never text, metadata, or secrets.
 */
export interface LedgerActivityEntry {
  readonly analysisId: string;
  readonly action: string;
  readonly tool: string | null;
  /** Digit string or null (non-numeric amounts are ignored). */
  readonly amountMinorUnits: string | null;
  /** Server-written created_at, epoch millis. */
  readonly createdAtMs: number;
}

/** Prior flag for repeat-violation counting (bounded, agent-scoped). */
export interface PriorFlagEntry {
  readonly category: RiskCategory;
  readonly status: string;
  /** Server-written created_at, epoch millis. */
  readonly createdAtMs: number;
}

export interface BehavioralHistory {
  readonly entries: readonly LedgerActivityEntry[];
  readonly priorFlags: readonly PriorFlagEntry[];
}

/** Minimum baseline rows before `novel-tool` may fire (new-agent guard). */
const MIN_BASELINE_ENTRIES = 3;

function finding(
  ruleId: BehavioralRuleId,
  category: RiskCategory,
  severity: "low" | "medium" | "high",
  confidence: number,
  what: string,
  whyItMatters: string,
  evidence: EngineEvidence,
): RuleFinding {
  return {
    ruleId,
    analyzerKind: "rule-based",
    category,
    severity,
    confidence,
    explanation: {
      what,
      whyItMatters,
      ruleId,
      ruleVersion: RULE_SET_V2,
    },
    evidence,
  };
}

function isDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function windowMinutes(hours: number): number {
  return hours * 60;
}

/**
 * Runs all four behavioral detectors in stable order. The activity
 * under analysis arrives as `current` and is counted alongside
 * `history` (which must NOT contain it).
 */
export function evaluateBehavioral(
  activity: NormalizedActivity,
  evidence: EngineEvidence,
  current: LedgerActivityEntry,
  history: BehavioralHistory,
  currentCategories: readonly RiskCategory[],
  nowMs: number,
): readonly RuleFinding[] {
  const thresholds = activity.policyContext.behavioralThresholds;
  return [
    ...detectActivityBurst(evidence, history, thresholds, nowMs),
    ...detectSpendVelocity(
      activity,
      evidence,
      current,
      history,
      thresholds,
      nowMs,
    ),
    ...detectNovelTool(activity, evidence, history, thresholds, nowMs),
    ...detectRepeatViolation(
      evidence,
      history,
      currentCategories,
      thresholds,
      nowMs,
    ),
  ];
}

/** A: unusually high analysis count within the policy window. */
export function detectActivityBurst(
  evidence: EngineEvidence,
  history: BehavioralHistory,
  thresholds: ResolvedBehavioralThresholds,
  nowMs: number,
): readonly RuleFinding[] {
  const cutoff = nowMs - thresholds.windowHours * MS_PER_HOUR;
  // The activity under analysis always counts; history must not
  // contain it (callers pass it separately).
  let count = 1;
  for (const entry of history.entries) {
    if (entry.createdAtMs > cutoff && entry.createdAtMs <= nowMs) {
      count += 1;
    }
  }
  if (count <= thresholds.burstCount) {
    return [];
  }
  const over = count - thresholds.burstCount;
  const severity = count >= 3 * thresholds.burstCount ? "high" : "medium";
  const confidence = Math.min(90, 60 + 2 * over);
  return [
    finding(
      "activity-burst",
      "anomalous-behavior",
      severity,
      confidence,
      `${count} analyses in ${windowMinutes(thresholds.windowHours)} minutes vs limit ${thresholds.burstCount}.`,
      "A sudden burst of agent activity can indicate automation runaway, compromised control, or flooding ahead of an attack.",
      evidence,
    ),
  ];
}

/** B: spend summed over the window vs limit × velocity multiple (BigInt). */
export function detectSpendVelocity(
  activity: NormalizedActivity,
  evidence: EngineEvidence,
  current: LedgerActivityEntry,
  history: BehavioralHistory,
  thresholds: ResolvedBehavioralThresholds,
  nowMs: number,
): readonly RuleFinding[] {
  const limit = activity.policyContext.spendLimitMinorUnits;
  if (limit === null || !isDigits(limit)) {
    return [];
  }
  const limitValue = BigInt(limit);
  if (limitValue === 0n) {
    return [];
  }
  const allowance = limitValue * BigInt(thresholds.velocityMultiple);
  const cutoff = nowMs - thresholds.windowHours * MS_PER_HOUR;
  let total = 0n;
  if (current.amountMinorUnits !== null && isDigits(current.amountMinorUnits)) {
    total += BigInt(current.amountMinorUnits);
  }
  for (const entry of history.entries) {
    if (entry.createdAtMs <= cutoff || entry.createdAtMs > nowMs) {
      continue;
    }
    if (entry.amountMinorUnits !== null && isDigits(entry.amountMinorUnits)) {
      total += BigInt(entry.amountMinorUnits);
    }
  }
  if (total <= allowance) {
    return [];
  }
  const ratio = total / allowance;
  const severity = ratio >= 3n ? "high" : "medium";
  const confidence = ratio >= 3n ? 80 : 70;
  return [
    finding(
      "spend-velocity",
      "overspend",
      severity,
      confidence,
      `Agent moved ${total.toString()} minor units in ${windowMinutes(thresholds.windowHours)} minutes vs velocity allowance ${allowance.toString()} (×${ratio.toString()} over).`,
      "Rapid cumulative spend can drain bonded value even when each single transfer stays under the per-action limit.",
      evidence,
    ),
  ];
}

/**
 * C: tool absent from the trailing baseline. Low severity only — a
 * novel tool is expected after legitimate agent upgrades, so this is
 * a signal for review, never a slash-grade finding.
 */
export function detectNovelTool(
  activity: NormalizedActivity,
  evidence: EngineEvidence,
  history: BehavioralHistory,
  thresholds: ResolvedBehavioralThresholds,
  nowMs: number,
): readonly RuleFinding[] {
  const tool = activity.tool;
  if (tool === null) {
    return [];
  }
  const cutoff = nowMs - thresholds.baselineDays * 24 * MS_PER_HOUR;
  const seen = new Set<string>();
  let baselineCount = 0;
  for (const entry of history.entries) {
    if (entry.createdAtMs <= cutoff || entry.createdAtMs > nowMs) {
      continue;
    }
    baselineCount += 1;
    if (entry.tool !== null) {
      seen.add(entry.tool);
    }
  }
  if (baselineCount < MIN_BASELINE_ENTRIES || seen.has(tool)) {
    return [];
  }
  return [
    finding(
      "novel-tool",
      "capability-mismatch",
      "low",
      60,
      `Agent used tool "${tool}" not seen in the trailing ${thresholds.baselineDays}-day baseline (${baselineCount} prior activities).`,
      "A first-seen tool may be a legitimate upgrade or undeclared scope drift; review, do not punish automatically.",
      evidence,
    ),
  ];
}

/**
 * D: repeated same-category findings in the window. Counts prior
 * flags with non-terminal-review status (open/under-review/attested);
 * dismissed/expired flags were reviewed away and do not count.
 * Monotonic: sustained violations can only add to the count.
 */
export function detectRepeatViolation(
  evidence: EngineEvidence,
  history: BehavioralHistory,
  currentCategories: readonly RiskCategory[],
  thresholds: ResolvedBehavioralThresholds,
  nowMs: number,
): readonly RuleFinding[] {
  const cutoff = nowMs - thresholds.repeatWindowHours * MS_PER_HOUR;
  const findings: RuleFinding[] = [];
  const distinct = [...new Set(currentCategories)].sort();
  for (const category of distinct) {
    let prior = 0;
    for (const flag of history.priorFlags) {
      if (flag.category !== category) {
        continue;
      }
      if (flag.createdAtMs <= cutoff || flag.createdAtMs > nowMs) {
        continue;
      }
      if (flag.status === "dismissed" || flag.status === "expired") {
        continue;
      }
      prior += 1;
    }
    const total = prior + 1;
    if (total < thresholds.repeatCount) {
      continue;
    }
    findings.push(
      finding(
        "repeat-violation",
        category,
        "high",
        75,
        `${total} ${category} findings in ${thresholds.repeatWindowHours} hours (including this one) vs repeat limit ${thresholds.repeatCount}.`,
        "Repeated violations of the same policy area indicate the agent is not correcting course after being flagged.",
        evidence,
      ),
    );
  }
  return findings;
}
