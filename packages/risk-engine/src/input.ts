/**
 * Normalized activity input model.
 *
 * The engine consumes GENERIC agent activity — no OpenAI/Claude/Gemini/
 * LangChain/CrewAI shapes anywhere. Provider specifics are normalized
 * away by adapters before reaching this boundary.
 *
 * Privacy: normalization REDACTS secret-like metadata keys (dropped, never
 * stored) and truncates free text. Raw secrets must never reach the engine;
 * this layer is a backstop, not an excuse to send them.
 */
import { DomainError, isIsoTimestamp } from "@bond/shared-types";
import type { AgentId } from "@bond/shared-types";
import { parseAgentId } from "@bond/shared-types";
import { resolveBehavioralThresholds } from "./behavioral.js";

export type ActivityType =
  | "tool-call"
  | "transfer"
  | "message"
  | "policy-decision"
  | "auth"
  | "config-change"
  | "external-report";

const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "tool-call",
  "transfer",
  "message",
  "policy-decision",
  "auth",
  "config-change",
  "external-report",
]);

export type ReporterSeverity = "low" | "medium" | "high" | "critical";

/** Policy context supplied by the caller (versioned policy, not engine config). */
export interface PolicyContext {
  readonly policyVersion: string;
  readonly allowedActions?: readonly string[];
  readonly declaredTools?: readonly string[];
  readonly denylistedActions?: readonly string[];
  readonly spendLimitMinorUnits?: string;
  readonly exfilThresholdBytes?: number;
  readonly behavioralThresholds?: BehavioralThresholdsInput;
}

/**
 * Optional behavioral thresholds (Phase 20). All fields optional with
 * safe defaults applied at normalization; all values are explicit,
 * validated integers — no environment reads, no hidden configuration.
 * They travel with the analyzed activity so results are reproducible.
 */
export interface BehavioralThresholdsInput {
  /** Burst/velocity window in hours. Integer 1–168. Default 1. */
  readonly windowHours?: number;
  /** Analyses within the window that trigger `activity-burst`. 2–1000. Default 10. */
  readonly burstCount?: number;
  /** Spend-velocity allowance as a multiple of spendLimit. 2–100. Default 3. */
  readonly velocityMultiple?: number;
  /** Trailing baseline for `novel-tool`, in days. 1–30. Default 7. */
  readonly baselineDays?: number;
  /** Same-category findings (incl. current) triggering `repeat-violation`. 2–20. Default 3. */
  readonly repeatCount?: number;
  /** Repeat-violation window in hours. 1–168. Default 24. */
  readonly repeatWindowHours?: number;
}

/** Fully resolved behavioral thresholds (defaults applied, validated). */
export interface ResolvedBehavioralThresholds {
  readonly windowHours: number;
  readonly burstCount: number;
  readonly velocityMultiple: number;
  readonly baselineDays: number;
  readonly repeatCount: number;
  readonly repeatWindowHours: number;
}

export interface RawActivityInput {
  readonly activityId: string;
  readonly agentId: string;
  readonly occurredAt: string;
  readonly actionType: string;
  readonly action: string;
  readonly tool?: string;
  readonly amountMinorUnits?: string;
  readonly externalDestination?: boolean;
  readonly bytesOut?: number;
  readonly textSnippet?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reporterSeverity?: ReporterSeverity;
  /** Provider-agnostic model attribution (adapter-supplied). */
  readonly provider?: string;
  readonly model?: string;
  /** Normalized usage counters (adapter-supplied, non-negative ints). */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** Adapter-reported cost estimate in minor units (digits, opaque). */
  readonly estimatedCostMinorUnits?: string;
  readonly policyContext: PolicyContext;
}

export type NormalizedMetadataValue = string | number | boolean | null;

export interface NormalizedActivity {
  readonly activityId: string;
  readonly agentId: AgentId;
  readonly occurredAt: string;
  readonly actionType: ActivityType;
  readonly action: string;
  readonly tool: string | null;
  readonly amountMinorUnits: string | null;
  readonly externalDestination: boolean;
  readonly bytesOut: number | null;
  readonly textSnippet: string | null;
  /** Redacted, canonical (sorted-key) metadata. Secrets are dropped. */
  readonly metadata: Readonly<Record<string, NormalizedMetadataValue>>;
  /** Metadata keys dropped as secret-like (for audit, not content). */
  readonly redactedFields: readonly string[];
  readonly reporterSeverity: ReporterSeverity | null;
  /** Provider-agnostic model attribution (null when not reported). */
  readonly provider: string | null;
  readonly model: string | null;
  /** Normalized usage counters (null when not reported). */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Adapter-reported cost estimate (null when not reported). */
  readonly estimatedCostMinorUnits: string | null;
  readonly policyContext: NormalizedPolicyContext;
}

export interface NormalizedPolicyContext {
  readonly policyVersion: string;
  readonly allowedActions: readonly string[] | null;
  readonly declaredTools: readonly string[] | null;
  readonly denylistedActions: readonly string[] | null;
  readonly spendLimitMinorUnits: string | null;
  readonly exfilThresholdBytes: number | null;
  /** Always resolved (defaults applied, ranges validated). */
  readonly behavioralThresholds: ResolvedBehavioralThresholds;
}

const MAX_TEXT_SNIPPET = 500;
const MAX_STRING_FIELD = 256;

/** Metadata keys matching this pattern are dropped, never stored. */
const SECRET_KEY_PATTERN =
  /api[_-]?key|secret|passwd|password|token|private[_-]?key|seed|mnemonic|auth|credential|bearer/i;

function fail(field: string, value: unknown): never {
  throw new DomainError(
    "INVALID_ACTIVITY_INPUT",
    `Invalid activity: ${field}`,
    {
      field,
      value,
    },
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(field, value);
  }
  const trimmed = (value as string).trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STRING_FIELD) {
    fail(field, value);
  }
  return trimmed;
}

/** Optional usage counters: non-negative safe integers only. */
function requireOptionalTokens(value: unknown, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    fail(field, value);
  }
  return value as number;
}

/** Optional adapter-reported cost: digit string, opaque minor units. */
function requireCost(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    fail("estimatedCostMinorUnits", value);
  }
  return value as string;
}

function normalizeMetadata(
  raw: Readonly<Record<string, unknown>> | undefined,
): { metadata: Record<string, NormalizedMetadataValue>; redacted: string[] } {
  const metadata: Record<string, NormalizedMetadataValue> = {};
  const redacted: string[] = [];
  if (raw === undefined) {
    return { metadata, redacted };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("metadata", raw);
  }
  for (const key of Object.keys(raw).sort()) {
    const value: unknown = (raw as Record<string, unknown>)[key];
    if (SECRET_KEY_PATTERN.test(key)) {
      redacted.push(key);
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      metadata[key] =
        typeof value === "string" ? value.slice(0, MAX_STRING_FIELD) : value;
    } else {
      // Non-primitives (objects/arrays) are dropped: unbounded shape,
      // possible secret nesting. Recorded as redacted for audit.
      redacted.push(key);
    }
  }
  return { metadata, redacted: redacted.sort() };
}

/**
 * Validates + normalizes raw activity. Pure and deterministic: same input
 * always yields the same output. Throws INVALID_ACTIVITY_INPUT.
 */
export function normalizeActivity(raw: RawActivityInput): NormalizedActivity {
  const activityId = requireNonEmptyString(raw.activityId, "activityId");
  const agentId = parseAgentId(raw.agentId);
  if (!isIsoTimestamp(raw.occurredAt)) {
    fail("occurredAt", raw.occurredAt);
  }
  if (!ACTIVITY_TYPES.has(raw.actionType)) {
    fail("actionType", raw.actionType);
  }
  const action = requireNonEmptyString(raw.action, "action");
  const policy = raw.policyContext;
  if (typeof policy !== "object" || policy === null) {
    fail("policyContext", policy);
  }
  const policyVersion = requireNonEmptyString(
    (policy as PolicyContext).policyVersion,
    "policyContext.policyVersion",
  );
  const { metadata, redacted } = normalizeMetadata(raw.metadata);
  return {
    activityId,
    agentId,
    occurredAt: raw.occurredAt,
    actionType: raw.actionType as ActivityType,
    action,
    tool:
      raw.tool === undefined ? null : requireNonEmptyString(raw.tool, "tool"),
    amountMinorUnits:
      raw.amountMinorUnits === undefined
        ? null
        : requireNonEmptyString(raw.amountMinorUnits, "amountMinorUnits"),
    externalDestination: raw.externalDestination ?? false,
    bytesOut: raw.bytesOut ?? null,
    textSnippet:
      raw.textSnippet === undefined
        ? null
        : raw.textSnippet.slice(0, MAX_TEXT_SNIPPET),
    metadata,
    redactedFields: redacted,
    reporterSeverity: raw.reporterSeverity ?? null,
    provider:
      raw.provider === undefined
        ? null
        : requireNonEmptyString(raw.provider, "provider"),
    model:
      raw.model === undefined
        ? null
        : requireNonEmptyString(raw.model, "model"),
    inputTokens: requireOptionalTokens(raw.inputTokens, "inputTokens"),
    outputTokens: requireOptionalTokens(raw.outputTokens, "outputTokens"),
    totalTokens: requireOptionalTokens(raw.totalTokens, "totalTokens"),
    estimatedCostMinorUnits:
      raw.estimatedCostMinorUnits === undefined
        ? null
        : requireCost(raw.estimatedCostMinorUnits),
    policyContext: {
      policyVersion,
      allowedActions: (policy as PolicyContext).allowedActions
        ? [...((policy as PolicyContext).allowedActions as readonly string[])]
        : null,
      declaredTools: (policy as PolicyContext).declaredTools
        ? [...((policy as PolicyContext).declaredTools as readonly string[])]
        : null,
      denylistedActions: (policy as PolicyContext).denylistedActions
        ? [
            ...((policy as PolicyContext)
              .denylistedActions as readonly string[]),
          ]
        : null,
      spendLimitMinorUnits:
        (policy as PolicyContext).spendLimitMinorUnits ?? null,
      exfilThresholdBytes:
        (policy as PolicyContext).exfilThresholdBytes ?? null,
      behavioralThresholds: resolveBehavioralThresholds(
        (policy as PolicyContext).behavioralThresholds,
      ),
    },
  };
}
