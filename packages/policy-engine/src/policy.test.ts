/**
 * Phase 22 policy-engine unit tests.
 *
 * Covers: validation (lists, ranges, window pairs, costs),
 * allow/deny providers and models, per-activity token limits,
 * cumulative token/cost/request windows, severity discipline
 * (never critical), determinism, explanation content, and the
 * null-policy (no persisted policy) path.
 */
import { describe, expect, it } from "vitest";
import { validatePolicyInput } from "./policy.js";
import type { ResolvedAgentPolicy } from "./policy.js";
import { POLICY_RULE_IDS, evaluatePolicy } from "./evaluate.js";
import type { PolicyActivityUsage, PolicyUsageWindow } from "./evaluate.js";

const QUIET_USAGE: PolicyUsageWindow = {
  requestCount: 0,
  totalTokens: "0",
  totalCostMinorUnits: "0",
};

function usage(overrides: Partial<PolicyUsageWindow> = {}): PolicyUsageWindow {
  return { ...QUIET_USAGE, ...overrides };
}

function activity(
  overrides: Partial<PolicyActivityUsage> = {},
): PolicyActivityUsage {
  return {
    provider: "acme",
    model: "acme-small",
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    costMinorUnits: "10",
    ...overrides,
  };
}

function policy(
  overrides: Partial<ResolvedAgentPolicy> = {},
): ResolvedAgentPolicy {
  return {
    version: 1,
    status: "active",
    allowedActions: null,
    deniedActions: [],
    allowedTools: null,
    deniedTools: [],
    allowedProviders: ["acme"],
    deniedProviders: [],
    allowedModels: ["acme-small"],
    deniedModels: [],
    maxInputTokens: 100000,
    maxOutputTokens: 100000,
    maxTotalTokens: 100000,
    maxTotalTokensPerWindow: null,
    tokenWindowSeconds: null,
    maxRequestsPerWindow: null,
    requestWindowSeconds: null,
    maxCostMinorUnitsPerRequest: null,
    maxCostMinorUnitsPerWindow: null,
    costWindowSeconds: null,
    maxTransferMinorUnits: null,
    ...overrides,
  };
}

function decide(
  act: PolicyActivityUsage = activity(),
  pol: ResolvedAgentPolicy | null = policy(),
  use: PolicyUsageWindow = QUIET_USAGE,
) {
  return evaluatePolicy({
    activity: act,
    policy: pol,
    usage: use,
    policyVersion: "agent-policy-v1",
  });
}

describe("validation", () => {
  it("accepts empty and full policies", () => {
    const empty = validatePolicyInput({});
    expect(empty.allowedProviders).toBeNull();
    expect(empty.deniedProviders).toEqual([]);
    expect(empty.maxInputTokens).toBeNull();
    const full = validatePolicyInput({
      allowedProviders: ["acme"],
      deniedModels: ["bad-model"],
      maxInputTokens: 1000,
      maxTotalTokensPerWindow: 5000,
      tokenWindowSeconds: 3600,
      maxRequestsPerWindow: 10,
      requestWindowSeconds: 60,
      maxCostMinorUnitsPerRequest: "500",
      maxCostMinorUnitsPerWindow: "1000",
      costWindowSeconds: 3600,
      maxTransferMinorUnits: "250",
    });
    expect(full.maxRequestsPerWindow).toBe(10);
    expect(full.maxTransferMinorUnits).toBe("250");
  });

  it("rejects non-objects, bad lists, and bad scalars", () => {
    for (const bad of [
      undefined,
      "nope",
      [],
      { allowedProviders: "acme" },
      { allowedProviders: [""] },
      { allowedProviders: Array.from({ length: 101 }, (_, i) => `p${i}`) },
      { maxInputTokens: 0 },
      { maxInputTokens: 1.5 },
      { maxInputTokens: 1_000_000_001 },
      { requestWindowSeconds: 59 },
      { requestWindowSeconds: 2_592_001 },
      { maxCostMinorUnitsPerRequest: "-5" },
      { maxCostMinorUnitsPerRequest: "12.5" },
      { maxCostMinorUnitsPerRequest: "" },
      { maxRequestsPerWindow: 0 },
    ]) {
      let code: string | null = null;
      try {
        validatePolicyInput(bad as never);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code, JSON.stringify(bad)).toBe("INVALID_POLICY");
    }
  });

  it("rejects half-paired windows fail-closed", () => {
    for (const bad of [
      { maxRequestsPerWindow: 10 },
      { requestWindowSeconds: 60 },
      { maxTotalTokensPerWindow: 100 },
      { tokenWindowSeconds: 60 },
      { maxCostMinorUnitsPerWindow: "100" },
      { costWindowSeconds: 60 },
    ]) {
      let code: string | null = null;
      try {
        validatePolicyInput(bad);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code, JSON.stringify(bad)).toBe("INVALID_POLICY");
    }
  });

  it("deduplicates list entries", () => {
    const resolved = validatePolicyInput({
      allowedProviders: ["acme", "acme"],
    });
    expect(resolved.allowedProviders).toEqual(["acme"]);
  });
});

describe("provider and model gates", () => {
  it("allows listed providers and models", () => {
    const decision = decide();
    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
    expect(decision.policyVersion).toBe("agent-policy-v1");
  });

  it("denies unlisted providers and models when allowlists exist", () => {
    const provider = decide(activity({ provider: "rival" }));
    expect(provider.allowed).toBe(false);
    expect(provider.violations[0]).toMatchObject({
      ruleId: "policy-provider-denied",
      severity: "high",
      category: "policy-violation",
      reasonCode: "PROVIDER_NOT_ALLOWED",
    });
    const model = decide(activity({ model: "acme-giant" }));
    expect(model.violations[0]?.ruleId).toBe("policy-model-denied");
  });

  it("deny wins over allow", () => {
    const decision = decide(activity(), policy({ deniedProviders: ["acme"] }));
    expect(decision.allowed).toBe(false);
    expect(decision.violations[0]?.ruleId).toBe("policy-provider-denied");
  });

  it("stays quiet without usage fields when unconstrained", () => {
    const decision = decide(
      activity({
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costMinorUnits: null,
      }),
      policy({ allowedProviders: null, allowedModels: null }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("token limits", () => {
  it("fires high on per-activity breaches with observed/limit", () => {
    const decision = decide(
      activity({ inputTokens: 150000, totalTokens: 150200 }),
      policy({ maxInputTokens: 100000, maxTotalTokens: 100000 }),
    );
    expect(decision.allowed).toBe(false);
    const input = decision.violations.find(
      (v) => v.ruleId === "policy-input-token-limit",
    );
    expect(input).toMatchObject({
      severity: "high",
      reasonCode: "INPUT_TOKEN_LIMIT",
      observed: "150000",
      limit: "100000",
    });
    expect(input?.explanation).toContain("150000");
    expect(input?.explanation).toContain("100000");
    expect(input?.policyVersion).toBe("agent-policy-v1");
  });

  it("fires cumulative window breaches (medium, escalating to high)", () => {
    const pol = policy({
      maxTotalTokensPerWindow: 1000,
      tokenWindowSeconds: 3600,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxTotalTokens: null,
    });
    const medium = decide(
      activity({ totalTokens: 200 }),
      pol,
      usage({ totalTokens: "900" }),
    );
    expect(
      medium.violations.find((v) => v.ruleId === "policy-cumulative-tokens"),
    ).toMatchObject({ severity: "medium" });
    const high = decide(
      activity({ totalTokens: 200 }),
      pol,
      usage({ totalTokens: "2900" }),
    );
    expect(
      high.violations.find((v) => v.ruleId === "policy-cumulative-tokens"),
    ).toMatchObject({ severity: "high" });
  });
});

describe("request and cost windows", () => {
  it("enforces request-count windows", () => {
    const pol = policy({
      maxRequestsPerWindow: 3,
      requestWindowSeconds: 60,
    });
    const ok = decide(activity(), pol, usage({ requestCount: 1 }));
    expect(ok.allowed).toBe(true);
    const over = decide(activity(), pol, usage({ requestCount: 3 }));
    expect(
      over.violations.find((v) => v.ruleId === "policy-request-rate-limit"),
    ).toMatchObject({
      severity: "medium",
      reasonCode: "REQUEST_RATE_LIMIT",
      observed: "4",
      limit: "3",
    });
  });

  it("enforces per-request and cumulative cost with BigInt math", () => {
    const per = decide(
      activity({ costMinorUnits: "800" }),
      policy({ maxCostMinorUnitsPerRequest: "500" }),
    );
    expect(
      per.violations.find((v) => v.ruleId === "policy-cost-limit"),
    ).toMatchObject({
      severity: "high",
      category: "overspend",
      reasonCode: "COST_LIMIT",
      observed: "800",
      limit: "500",
    });
    const cumulative = decide(
      activity({ costMinorUnits: "100" }),
      policy({
        maxCostMinorUnitsPerWindow: "1000",
        costWindowSeconds: 3600,
      }),
      usage({ totalCostMinorUnits: "950" }),
    );
    expect(
      cumulative.violations.find((v) => v.ruleId === "policy-cumulative-cost"),
    ).toMatchObject({ severity: "medium" });
  });

  it("ignores non-numeric usage gracefully", () => {
    const decision = decide(
      activity({ costMinorUnits: "not-a-number" }),
      policy({ maxCostMinorUnitsPerRequest: "500" }),
      usage({ totalTokens: "garbage", totalCostMinorUnits: "garbage" }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("decision discipline", () => {
  it("null policy allows with no violations", () => {
    const decision = decide(activity(), null);
    expect(decision).toEqual({
      allowed: true,
      violations: [],
      policyVersion: "agent-policy-v1",
    });
  });

  it("never emits critical severity", () => {
    const decision = decide(
      activity({
        provider: "rival",
        model: "rival-giant",
        inputTokens: 999_999_999,
        outputTokens: 999_999_999,
        totalTokens: 999_999_999,
        costMinorUnits: "999999999999999999999999999999",
      }),
      policy({
        deniedProviders: ["rival"],
        deniedModels: ["rival-giant"],
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxTotalTokens: 1,
        maxTotalTokensPerWindow: 1,
        tokenWindowSeconds: 60,
        maxRequestsPerWindow: 1,
        requestWindowSeconds: 60,
        maxCostMinorUnitsPerRequest: "1",
        maxCostMinorUnitsPerWindow: "1",
        costWindowSeconds: 60,
      }),
      usage({
        requestCount: 999999,
        totalTokens: "999999999999",
        totalCostMinorUnits: "999999999999",
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violations.length).toBeGreaterThan(0);
    for (const violation of decision.violations) {
      expect(violation.severity).not.toBe("critical");
    }
  });

  it("is deterministic and exposes exactly nine rule ids", () => {
    const first = decide();
    const second = decide();
    expect(first).toEqual(second);
    expect([...POLICY_RULE_IDS]).toEqual([
      "policy-provider-denied",
      "policy-model-denied",
      "policy-input-token-limit",
      "policy-output-token-limit",
      "policy-total-token-limit",
      "policy-cumulative-tokens",
      "policy-request-rate-limit",
      "policy-cost-limit",
      "policy-cumulative-cost",
    ]);
  });
});
