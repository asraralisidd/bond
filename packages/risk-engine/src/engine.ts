/**
 * RiskEngine: activity → advisory RiskFlags. Nothing more.
 *
 * SECURITY BOUNDARY: this module can construct RiskFlag, EvidenceRef, and
 * scoring output. It cannot construct SlashEvent, Attestation, Bond
 * transitions, Transactions, or anything chain-facing — those types are
 * not even imported. The engine reports; other components decide.
 *
 * Determinism: no clock, no randomness, no environment reads in the core
 * path. Flag `detectedAt` comes from the activity itself; IDs derive from
 * content digests, so identical input reproduces identical output.
 */
import {
  createRiskFlag,
  parseRiskFlagId,
  toLogMetadata,
} from "@bond/shared-types";
import type {
  AgentId,
  DomainLogMetadata,
  EvidenceRef,
  RiskFlag,
} from "@bond/shared-types";
import { dedupeByActivityKey } from "./dedup.js";
import { activityKey, deriveEvidence, toEvidenceRef } from "./evidence.js";
import { normalizeActivity } from "./input.js";
import type { RawActivityInput } from "./input.js";
import { evaluateRules, DEFAULT_ANALYZERS } from "./rules.js";
import type { ActivityAnalyzer, RuleFinding } from "./rules.js";
import { scoreFindings } from "./scoring.js";
import type { RiskScore } from "./scoring.js";
import {
  ENGINE_VERSION,
  RULE_SET_VERSION,
  SCORING_MODEL_VERSION,
  scorerVersionString,
} from "./versions.js";

export interface AnalyzeOptions {
  /** Extra analyzers appended after the default set (e.g. future ML). */
  readonly extraAnalyzers?: readonly ActivityAnalyzer[];
  /** Previously seen activity keys for dedup (Phase 7 persists these). */
  readonly seenKeys?: ReadonlySet<string>;
  /** Correlates this analysis with the inbound request (Phase 0 doc 14). */
  readonly requestId?: string;
}

export interface RiskAnalysisResult {
  /** Deterministic: derived from the analyzed activity key(s). */
  readonly analysisId: string;
  readonly agentId: AgentId;
  readonly flags: readonly RiskFlag[];
  readonly score: RiskScore | null;
  readonly findings: readonly RuleFinding[];
  readonly evidence: readonly EvidenceRef[];
  readonly skippedDuplicateKeys: readonly string[];
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly ruleSetVersion: typeof RULE_SET_VERSION;
  readonly scoringVersion: typeof SCORING_MODEL_VERSION;
  readonly logMetadata: DomainLogMetadata;
}

function buildFlags(
  agentId: AgentId,
  findings: readonly RuleFinding[],
  occurredAt: string,
): readonly RiskFlag[] {
  return findings.map((finding) =>
    createRiskFlag({
      riskFlagId: parseRiskFlagId(
        `rf-${finding.evidence.digest}-${finding.ruleId}`,
      ),
      agentId,
      category: finding.category,
      severity: finding.severity,
      // Integer 0–100 → 0–1 at the domain boundary.
      confidence: finding.confidence / 100,
      evidenceRefs: [toEvidenceRef(finding.evidence)],
      detectedAt: occurredAt,
      modelVersion: scorerVersionString(),
    }),
  );
}

/**
 * Analyzes one normalized activity end-to-end. Pure: identical input +
 * identical options yield identical output.
 */
export function analyzeActivity(
  raw: RawActivityInput,
  options: AnalyzeOptions = {},
): RiskAnalysisResult {
  const activity = normalizeActivity(raw);
  const evidence = deriveEvidence(activity);
  const key = activityKey(activity);
  const findings = evaluateRules(
    activity,
    evidence,
    options.extraAnalyzers
      ? [...DEFAULT_ANALYZERS, ...options.extraAnalyzers]
      : undefined,
  );
  const { findings: kept, skippedDuplicateKeys } = dedupeByActivityKey(
    activity,
    findings,
    options.seenKeys ?? new Set<string>(),
  );
  const score = scoreFindings(kept);
  const flags = buildFlags(activity.agentId, kept, activity.occurredAt);
  return {
    analysisId: `analysis-${key}`,
    agentId: activity.agentId,
    flags,
    score,
    findings: kept,
    evidence: kept.length > 0 ? [toEvidenceRef(evidence)] : [],
    skippedDuplicateKeys,
    engineVersion: ENGINE_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    scoringVersion: SCORING_MODEL_VERSION,
    logMetadata: toLogMetadata({
      requestId: options.requestId ?? null,
      agentId: activity.agentId,
    }),
  };
}

/**
 * Analyzes a batch with cross-item dedup: the first occurrence of
 * repeated activity flags once; repeats are reported as skipped.
 * Deterministic for identical batches in identical order.
 */
export function analyzeBatch(
  raws: readonly RawActivityInput[],
  options: AnalyzeOptions = {},
): RiskAnalysisResult[] {
  const seen = new Set<string>(options.seenKeys ?? []);
  return raws.map((raw) => {
    const result = analyzeActivity(raw, { ...options, seenKeys: seen });
    const activity = normalizeActivity(raw);
    seen.add(activityKey(activity));
    return result;
  });
}
