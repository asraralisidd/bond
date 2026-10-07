/**
 * Pure policy evaluator (POLICY v1, Phase 22).
 *
 * PURE FUNCTIONS ONLY: the activity, the resolved policy, and
 * pre-aggregated usage arrive as explicit arguments. This module
 * never queries databases, never reads the environment or the wall
 * clock, never uses randomness, never touches the network, and
 * never imports API, wallet, Midnight, attestor, risk-engine, or
 * enforcement code.
 *
 * Scope discipline (no duplication):
 * - Actions/tools/denylists and per-activity transfer caps are
 *   enforced by risk-engine v1 rules over the EFFECTIVE policy
 *   context (the service overlays persisted policy fields there).
 *   This evaluator does NOT re-check them.
 * - This evaluator owns: provider/model allow-deny, per-activity
 *   token limits, cumulative token/cost/request windows.
 *
 * Severity ceiling: violations NEVER exceed HIGH and NEVER produce
 * CRITICAL — a config-based check alone must not create
 * slash-grade pressure. Integer arithmetic only (BigInt for money,
 * plain integers for tokens/counts).
 */
import type { RiskCategory } from "@bond/shared-types";
import type { ResolvedAgentPolicy } from "./policy.js";

export const POLICY_RULE_IDS = [
  "policy-provider-denied",
  "policy-model-denied",
  "policy-input-token-limit",
  "policy-output-token-limit",
  "policy-total-token-limit",
  "policy-cumulative-tokens",
  "policy-request-rate-limit",
  "policy-cost-limit",
  "policy-cumulative-cost",
] as const;

export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

/** Normalized model-usage subset of an analyzed activity. */
export interface PolicyActivityUsage {
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Digit string or null (non-numeric costs are ignored). */
  readonly costMinorUnits: string | null;
}

/**
 * Server-aggregated usage over the policy windows (bounded,
 * server-time queries in the API layer). Totals arrive as digit
 * strings so BigInt math never loses precision.
 */
export interface PolicyUsageWindow {
  /** Analyses in the request window (exact COUNT(*)). */
  readonly requestCount: number;
  /** Summed total_tokens in the token window (digits, "0" if none). */
  readonly totalTokens: string;
  /** Summed cost in the cost window (digits, "0" if none). */
  readonly totalCostMinorUnits: string;
}

export interface PolicyViolation {
  readonly ruleId: PolicyRuleId;
  readonly severity: "low" | "medium" | "high";
  readonly category: RiskCategory;
  readonly confidence: number;
  readonly reasonCode: string;
  /** Observed value, rendered for explanations. */
  readonly observed: string;
  /** Configured threshold, rendered for explanations. */
  readonly limit: string;
  readonly explanation: string;
  /** Governing policy label (e.g. `agent-policy-v3`). */
  readonly policyVersion: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly violations: readonly PolicyViolation[];
  readonly policyVersion: string;
}

function violation(
  ruleId: PolicyRuleId,
  severity: "low" | "medium" | "high",
  category: RiskCategory,
  confidence: number,
  reasonCode: string,
  observed: string,
  limit: string,
  explanation: string,
  policyVersion: string,
): PolicyViolation {
  return {
    ruleId,
    severity,
    category,
    confidence,
    reasonCode,
    observed,
    limit,
    explanation,
    policyVersion,
  };
}

function isDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function deniedOrNotAllowed(
  value: string | null,
  allowed: readonly string[] | null,
  denied: readonly string[],
): boolean {
  if (value === null) {
    return false;
  }
  if (denied.includes(value)) {
    return true;
  }
  return allowed !== null && !allowed.includes(value);
}

function limitSeverity(over: bigint, allowance: bigint): "medium" | "high" {
  return over >= allowance * 2n ? "high" : "medium";
}

/**
 * Evaluates one activity against a resolved policy. Deterministic:
 * identical inputs always yield identical outputs. A null policy
 * means the agent has no persisted policy — nothing governed here
 * is constrained, so the decision is allow with no violations (v1
 * rules still evaluate the caller-supplied context as before).
 */
export function evaluatePolicy(input: {
  readonly activity: PolicyActivityUsage;
  readonly policy: ResolvedAgentPolicy | null;
  readonly usage: PolicyUsageWindow;
  readonly policyVersion: string;
}): PolicyDecision {
  const { activity, policy, usage, policyVersion } = input;
  if (policy === null) {
    return { allowed: true, violations: [], policyVersion };
  }
  const violations: PolicyViolation[] = [];
  const { provider, model } = activity;

  if (
    deniedOrNotAllowed(
      provider,
      policy.allowedProviders,
      policy.deniedProviders,
    )
  ) {
    violations.push(
      violation(
        "policy-provider-denied",
        "high",
        "policy-violation",
        90,
        "PROVIDER_NOT_ALLOWED",
        provider as string,
        policy.allowedProviders === null
          ? `denied: ${provider as string}`
          : `allowed: [${policy.allowedProviders.join(", ")}]`,
        `Agent used provider "${provider}" which the active policy does not allow.`,
        policyVersion,
      ),
    );
  }
  if (deniedOrNotAllowed(model, policy.allowedModels, policy.deniedModels)) {
    violations.push(
      violation(
        "policy-model-denied",
        "high",
        "policy-violation",
        90,
        "MODEL_NOT_ALLOWED",
        model as string,
        policy.allowedModels === null
          ? `denied: ${model as string}`
          : `allowed: [${policy.allowedModels.join(", ")}]`,
        `Agent used model "${model}" which the active policy does not allow.`,
        policyVersion,
      ),
    );
  }

  const tokenChecks: ReadonlyArray<{
    readonly ruleId: Extract<
      PolicyRuleId,
      | "policy-input-token-limit"
      | "policy-output-token-limit"
      | "policy-total-token-limit"
    >;
    readonly reasonCode: string;
    readonly observed: number | null;
    readonly limit: number | null;
    readonly label: string;
  }> = [
    {
      ruleId: "policy-input-token-limit",
      reasonCode: "INPUT_TOKEN_LIMIT",
      observed: activity.inputTokens,
      limit: policy.maxInputTokens,
      label: "input",
    },
    {
      ruleId: "policy-output-token-limit",
      reasonCode: "OUTPUT_TOKEN_LIMIT",
      observed: activity.outputTokens,
      limit: policy.maxOutputTokens,
      label: "output",
    },
    {
      ruleId: "policy-total-token-limit",
      reasonCode: "TOTAL_TOKEN_LIMIT",
      observed: activity.totalTokens,
      limit: policy.maxTotalTokens,
      label: "total",
    },
  ];
  for (const check of tokenChecks) {
    if (check.observed === null || check.limit === null) {
      continue;
    }
    if (check.observed <= check.limit) {
      continue;
    }
    // Hard per-activity caps are deterministic: breaching one is a
    // high-severity violation, not a statistical signal.
    violations.push(
      violation(
        check.ruleId,
        "high",
        "policy-violation",
        80,
        check.reasonCode,
        String(check.observed),
        String(check.limit),
        `Agent used ${check.observed} ${check.label} tokens against a per-activity limit of ${check.limit}.`,
        policyVersion,
      ),
    );
  }

  if (
    policy.maxTotalTokensPerWindow !== null &&
    policy.tokenWindowSeconds !== null &&
    isDigits(usage.totalTokens)
  ) {
    const windowTotal =
      BigInt(usage.totalTokens) + BigInt(activity.totalTokens ?? 0);
    const allowance = BigInt(policy.maxTotalTokensPerWindow);
    if (windowTotal > allowance) {
      const severity = limitSeverity(windowTotal - allowance, allowance);
      violations.push(
        violation(
          "policy-cumulative-tokens",
          severity,
          "policy-violation",
          severity === "high" ? 80 : 75,
          "TOTAL_TOKEN_LIMIT",
          windowTotal.toString(),
          allowance.toString(),
          `Agent token usage of ${windowTotal.toString()} in the trailing ${policy.tokenWindowSeconds}s window exceeds the allowance of ${allowance.toString()}.`,
          policyVersion,
        ),
      );
    }
  }

  if (policy.maxRequestsPerWindow !== null) {
    const count = usage.requestCount + 1;
    if (count > policy.maxRequestsPerWindow) {
      violations.push(
        violation(
          "policy-request-rate-limit",
          "medium",
          "policy-violation",
          75,
          "REQUEST_RATE_LIMIT",
          String(count),
          String(policy.maxRequestsPerWindow),
          `Agent made ${count} requests in the trailing ${String(policy.requestWindowSeconds)}s window against a limit of ${String(policy.maxRequestsPerWindow)}.`,
          policyVersion,
        ),
      );
    }
  }

  if (
    activity.costMinorUnits !== null &&
    isDigits(activity.costMinorUnits) &&
    policy.maxCostMinorUnitsPerRequest !== null
  ) {
    const cost = BigInt(activity.costMinorUnits);
    const allowance = BigInt(policy.maxCostMinorUnitsPerRequest);
    if (cost > allowance) {
      violations.push(
        violation(
          "policy-cost-limit",
          "high",
          "overspend",
          80,
          "COST_LIMIT",
          cost.toString(),
          allowance.toString(),
          `Agent activity cost ${cost.toString()} minor units exceeds the per-request limit of ${allowance.toString()}. Costs are adapter-reported estimates, not provider billing.`,
          policyVersion,
        ),
      );
    }
  }

  if (
    policy.maxCostMinorUnitsPerWindow !== null &&
    isDigits(usage.totalCostMinorUnits)
  ) {
    const windowCost =
      BigInt(usage.totalCostMinorUnits) +
      BigInt(
        activity.costMinorUnits !== null && isDigits(activity.costMinorUnits)
          ? activity.costMinorUnits
          : "0",
      );
    const allowance = BigInt(policy.maxCostMinorUnitsPerWindow);
    if (windowCost > allowance) {
      const severity = limitSeverity(windowCost - allowance, allowance);
      violations.push(
        violation(
          "policy-cumulative-cost",
          severity,
          "overspend",
          severity === "high" ? 80 : 75,
          "COST_LIMIT",
          windowCost.toString(),
          allowance.toString(),
          `Agent cost of ${windowCost.toString()} minor units in the trailing ${String(policy.costWindowSeconds)}s window exceeds the allowance of ${allowance.toString()}. Costs are adapter-reported estimates, not provider billing.`,
          policyVersion,
        ),
      );
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    policyVersion,
  };
}
