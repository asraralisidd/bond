/**
 * Provider-agnostic activity builder. Constructs the exact
 * RawActivityInput contract the backend validates — no OpenAI, Claude,
 * Gemini, LangChain, CrewAI, or other provider shapes anywhere.
 *
 * Defaults: activityId (UUID) and occurredAt (current ISO timestamp).
 * Validation mirrors server rules so malformed payloads fail fast
 * client-side; the server remains authoritative.
 */
import { BondApiError } from "./errors.js";
import { redactMetadata, truncateSnippet } from "./redact.js";

export type ActivityType =
  | "tool-call"
  | "transfer"
  | "message"
  | "policy-decision"
  | "auth"
  | "config-change"
  | "external-report";

export const ACTIVITY_TYPES: readonly ActivityType[] = [
  "tool-call",
  "transfer",
  "message",
  "policy-decision",
  "auth",
  "config-change",
  "external-report",
];

export type ReporterSeverity = "low" | "medium" | "high" | "critical";

export interface ActivityPolicyContext {
  readonly policyVersion: string;
  readonly allowedActions?: readonly string[];
  readonly declaredTools?: readonly string[];
  readonly denylistedActions?: readonly string[];
  readonly spendLimitMinorUnits?: string;
  readonly exfilThresholdBytes?: number;
}

export interface ActivityInput {
  readonly activityId?: string;
  readonly agentId: string;
  readonly occurredAt?: string;
  readonly actionType: ActivityType;
  readonly action: string;
  readonly tool?: string;
  readonly amountMinorUnits?: string;
  readonly externalDestination?: boolean;
  readonly bytesOut?: number;
  readonly textSnippet?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reporterSeverity?: ReporterSeverity;
  readonly policyContext: ActivityPolicyContext;
}

export interface BuiltActivity {
  readonly activityId: string;
  readonly agentId: string;
  readonly occurredAt: string;
  readonly actionType: ActivityType;
  readonly action: string;
  readonly tool?: string;
  readonly amountMinorUnits?: string;
  readonly externalDestination?: boolean;
  readonly bytesOut?: number;
  readonly textSnippet?: string | null;
  readonly metadata?: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly reporterSeverity?: ReporterSeverity;
  readonly policyContext: ActivityPolicyContext;
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function invalid(message: string): BondApiError {
  return new BondApiError("INVALID_ACTIVITY_INPUT", message, 0, null);
}

function requireText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`Invalid activity: ${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw invalid(`Invalid activity: ${field} exceeds ${max} characters`);
  }
  return trimmed;
}

/**
 * Builds a validated activity payload. Applies activityId/occurredAt
 * defaults, redacts secret-like metadata keys, and truncates free text —
 * all compatible with backend validation.
 */
export function buildActivity(input: ActivityInput): BuiltActivity {
  const activityId =
    input.activityId === undefined
      ? crypto.randomUUID()
      : requireText(input.activityId, "activityId");
  const agentId = requireText(input.agentId, "agentId", 128);
  const occurredAt =
    input.occurredAt === undefined
      ? new Date().toISOString()
      : requireText(input.occurredAt, "occurredAt");
  if (!ISO_TIMESTAMP_PATTERN.test(occurredAt)) {
    throw invalid("Invalid activity: occurredAt must be an ISO timestamp");
  }
  if (!(ACTIVITY_TYPES as readonly string[]).includes(input.actionType)) {
    throw invalid(
      `Invalid activity: actionType must be one of ${ACTIVITY_TYPES.join(", ")}`,
    );
  }
  const action = requireText(input.action, "action");
  if (typeof input.policyContext !== "object" || input.policyContext === null) {
    throw invalid("Invalid activity: policyContext is required");
  }
  const policyVersion = requireText(
    input.policyContext.policyVersion,
    "policyContext.policyVersion",
  );
  const { metadata } = redactMetadata(input.metadata);

  type MutableBuilt = {
    -readonly [K in keyof BuiltActivity]: BuiltActivity[K];
  };
  const built: MutableBuilt = {
    activityId,
    agentId,
    occurredAt,
    actionType: input.actionType,
    action,
    policyContext: { ...input.policyContext, policyVersion },
  };
  if (input.tool !== undefined) {
    built.tool = requireText(input.tool, "tool");
  }
  if (input.amountMinorUnits !== undefined) {
    built.amountMinorUnits = requireText(
      input.amountMinorUnits,
      "amountMinorUnits",
    );
  }
  if (input.externalDestination !== undefined) {
    built.externalDestination = input.externalDestination;
  }
  if (input.bytesOut !== undefined) {
    built.bytesOut = input.bytesOut;
  }
  if (input.textSnippet !== undefined) {
    built.textSnippet = truncateSnippet(input.textSnippet);
  }
  if (input.metadata !== undefined) {
    built.metadata = metadata;
  }
  if (input.reporterSeverity !== undefined) {
    built.reporterSeverity = input.reporterSeverity;
  }
  return built;
}
