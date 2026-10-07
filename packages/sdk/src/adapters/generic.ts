/**
 * Generic framework adapter boundary (Phase 24).
 *
 * For custom/in-house agent frameworks with no dedicated BOND
 * adapter: callers describe their event explicitly and receive a
 * validated activity payload. No guessing, no schema sniffing —
 * the caller asserts the mapping, and the builder validates it like
 * any hand-built activity. Output is the same normalized protocol
 * representation every adapter produces.
 */
import { ACTIVITY_TYPES, buildActivity } from "../activity.js";
import type {
  ActivityPolicyContext,
  ActivityType,
  BuiltActivity,
} from "../activity.js";
import { BondApiError } from "../errors.js";
import type { NormalizedModelUsage } from "../providers/index.js";

export interface DescribedFrameworkEvent {
  readonly actionType: ActivityType;
  readonly action: string;
  readonly tool?: string;
  readonly textSnippet?: string;
  readonly metadata?: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly usage?: NormalizedModelUsage;
  readonly activityId?: string;
  readonly occurredAt?: string;
}

export interface FrameworkAdapterConfig {
  readonly agentId: string;
  readonly policyContext: ActivityPolicyContext;
}

/**
 * Build an activity from an explicitly described framework event.
 * Usage counters/identifiers come from normalized provider usage;
 * prompts and completions are never accepted here.
 */
export function describeFrameworkEvent(
  config: FrameworkAdapterConfig,
  event: DescribedFrameworkEvent,
): BuiltActivity {
  if (!(ACTIVITY_TYPES as readonly string[]).includes(event.actionType)) {
    throw new BondApiError(
      "INVALID_ACTIVITY_INPUT",
      `Invalid framework event: unknown action type ${event.actionType}`,
      0,
      null,
    );
  }
  return buildActivity({
    agentId: config.agentId,
    actionType: event.actionType,
    action: event.action,
    policyContext: config.policyContext,
    ...(event.activityId !== undefined ? { activityId: event.activityId } : {}),
    ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
    ...(event.tool !== undefined ? { tool: event.tool } : {}),
    ...(event.textSnippet !== undefined
      ? { textSnippet: event.textSnippet }
      : {}),
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    ...(event.usage?.provider !== undefined
      ? { provider: event.usage.provider }
      : {}),
    ...(event.usage?.model != null ? { model: event.usage.model } : {}),
    ...(event.usage?.inputTokens != null
      ? { inputTokens: event.usage.inputTokens }
      : {}),
    ...(event.usage?.outputTokens != null
      ? { outputTokens: event.usage.outputTokens }
      : {}),
    ...(event.usage?.totalTokens != null
      ? { totalTokens: event.usage.totalTokens }
      : {}),
    ...(event.usage?.estimatedCostMinorUnits != null
      ? { estimatedCostMinorUnits: event.usage.estimatedCostMinorUnits }
      : {}),
  });
}
