/**
 * Phase 24 provider normalization tests (TypeScript).
 *
 * Covers all five providers, totals rules, strict validation,
 * cost honesty (never fabricated), request-id handling, and the
 * generic framework adapter boundary.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeAnthropicUsage,
  normalizeDeepSeekUsage,
  normalizeGeminiUsage,
  normalizeLocalUsage,
  normalizeOpenAIUsage,
  normalizeUsage,
} from "./index.js";
import { describeFrameworkEvent } from "../adapters/generic.js";
import { buildModelActivity } from "../activity.js";
import { BondApiError } from "../errors.js";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
  return null;
}

describe("provider normalizers", () => {
  it("normalizes OpenAI responses", () => {
    const usage = normalizeOpenAIUsage({
      model: "gpt-4o",
      id: "chatcmpl-abc",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    });
    expect(usage).toEqual({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      estimatedCostMinorUnits: null,
      providerRequestId: "chatcmpl-abc",
    });
  });

  it("derives Anthropic totals as input+output", () => {
    const usage = normalizeAnthropicUsage({
      model: "claude-sonnet-4",
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    expect(usage.totalTokens).toBe(12);
    expect(usage.providerRequestId).toBeNull();
  });

  it("normalizes Gemini metadata with explicit model", () => {
    const usage = normalizeGeminiUsage(
      {
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 4,
          totalTokenCount: 7,
        },
      },
      { model: "gemini-2.0-flash" },
    );
    expect(usage).toMatchObject({
      provider: "gemini",
      model: "gemini-2.0-flash",
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
  });

  it("normalizes DeepSeek and local shapes", () => {
    expect(
      normalizeDeepSeekUsage({
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }).provider,
    ).toBe("deepseek");
    const local = normalizeLocalUsage({
      provider: "ollama",
      model: "llama3",
      input_tokens: 8,
      output_tokens: 9,
      cost_minor_units: "42",
    });
    expect(local).toMatchObject({
      provider: "ollama",
      totalTokens: 17,
      estimatedCostMinorUnits: "42",
    });
  });

  it("keeps explicit totals even when inconsistent, derives when absent", () => {
    const kept = normalizeOpenAIUsage({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 99 },
    });
    expect(kept.totalTokens).toBe(99);
    const derived = normalizeLocalUsage({
      input_tokens: 4,
      output_tokens: 6,
    });
    expect(derived.totalTokens).toBe(10);
    const absent = normalizeLocalUsage({});
    expect(absent.totalTokens).toBeNull();
    expect(absent.inputTokens).toBeNull();
  });

  it("rejects negatives, floats, bools, strings, and oversized values", () => {
    for (const usage of [
      { prompt_tokens: -1 },
      { prompt_tokens: 1.5 },
      { prompt_tokens: true },
      { prompt_tokens: "10" },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(
        codeOf(() => normalizeOpenAIUsage({ usage })),
        JSON.stringify(usage),
      ).toBe("INVALID_ACTIVITY_INPUT");
    }
    expect(codeOf(() => normalizeOpenAIUsage(null))).toBe(
      "INVALID_ACTIVITY_INPUT",
    );
  });

  it("never fabricates costs", () => {
    const usage = normalizeOpenAIUsage({
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect(usage.estimatedCostMinorUnits).toBeNull();
    expect(
      codeOf(() => normalizeLocalUsage({ cost_minor_units: "12.5" })),
    ).toBe("INVALID_ACTIVITY_INPUT");
  });

  it("accepts model overrides and reads objects", () => {
    const usage = normalizeGeminiUsage(
      { usageMetadata: { promptTokenCount: 1 } },
      { model: "gemini-pro" },
    );
    expect(usage.model).toBe("gemini-pro");
    expect(usage.inputTokens).toBe(1);
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBe(1);
  });
});

describe("buildModelActivity", () => {
  it("builds a model-invocation activity from normalized usage", () => {
    const activity = buildModelActivity(
      "agent-1",
      {
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        estimatedCostMinorUnits: null,
        providerRequestId: "chatcmpl-abc",
      },
      { policyVersion: "bond-policy-v1" },
      { activityId: "act-1", occurredAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(activity).toMatchObject({
      activityId: "act-1",
      agentId: "agent-1",
      actionType: "tool-call",
      action: "model-invocation",
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 10,
      totalTokens: 30,
    });
    expect(activity).not.toHaveProperty("tool");
  });

  it("defaults the activity id from the provider request id", () => {
    const activity = buildModelActivity(
      "agent-1",
      {
        provider: "openai",
        model: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostMinorUnits: null,
        providerRequestId: "chatcmpl-xyz",
      },
      { policyVersion: "bond-policy-v1" },
      { occurredAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(activity.activityId).toBe("chatcmpl-xyz");
  });

  it("rejects missing providers", () => {
    expect(
      codeOf(() =>
        buildModelActivity(
          "agent-1",
          {
            provider: "  ",
            model: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            estimatedCostMinorUnits: null,
            providerRequestId: null,
          },
          { policyVersion: "bond-policy-v1" },
        ),
      ),
    ).toBe("INVALID_ACTIVITY_INPUT");
  });
});

describe("generic framework adapter", () => {
  const config = {
    agentId: "agent-1",
    policyContext: { policyVersion: "bond-policy-v1" },
  };

  it("maps described events with usage", () => {
    const activity = describeFrameworkEvent(config, {
      actionType: "tool-call",
      action: "custom-tool",
      tool: "custom-tool",
      activityId: "act-9",
      occurredAt: "2026-01-01T00:00:00.000Z",
      usage: {
        provider: "local",
        model: null,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        estimatedCostMinorUnits: null,
        providerRequestId: null,
      },
    });
    expect(activity).toMatchObject({
      action: "custom-tool",
      tool: "custom-tool",
      provider: "local",
      totalTokens: 5,
    });
  });

  it("rejects unknown action types", () => {
    let error: unknown = null;
    try {
      describeFrameworkEvent(config, {
        actionType: "teleport" as never,
        action: "x",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BondApiError);
    expect((error as BondApiError).code).toBe("INVALID_ACTIVITY_INPUT");
  });
});

describe("normalizeUsage core", () => {
  it("reads attribute-bearing objects, not just mappings", () => {
    class FakeUsage {
      prompt_tokens = 7;
      completion_tokens = 8;
      total_tokens = 15;
    }
    class FakeResponse {
      model = "gpt-x";
      usage = new FakeUsage();
    }
    const usage = normalizeUsage("openai", new FakeResponse(), {
      inputKeys: ["prompt_tokens"],
      outputKeys: ["completion_tokens"],
      totalKeys: ["total_tokens"],
    });
    expect(usage).toMatchObject({
      model: "gpt-x",
      inputTokens: 7,
      totalTokens: 15,
    });
  });
});
