/**
 * Local/custom model usage normalization.
 *
 * Accepts a small family of common key spellings so self-hosted and
 * custom providers map without bespoke code. Anything outside the
 * accepted keys is ignored; costs map only from explicit
 * digit-string fields. No price tables exist in BOND.
 */
import { normalizeUsage } from "./usage.js";
import type { NormalizedModelUsage } from "./usage.js";

function responseProvider(response: unknown): string | undefined {
  if (typeof response === "object" && response !== null) {
    const value = (response as Record<string, unknown>)["provider"];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function normalizeLocalUsage(
  response: unknown,
  options: { provider?: string; model?: string } = {},
): NormalizedModelUsage {
  return normalizeUsage(
    options.provider ?? responseProvider(response) ?? "local",
    response,
    {
      model: options.model,
      inputKeys: [
        "input_tokens",
        "prompt_tokens",
        "promptTokenCount",
        "prompt_token_count",
      ],
      outputKeys: [
        "output_tokens",
        "completion_tokens",
        "candidatesTokenCount",
        "candidates_token_count",
      ],
      totalKeys: ["total_tokens", "totalTokenCount", "total_token_count"],
      costKeys: ["cost_minor_units", "cost", "estimated_cost_minor_units"],
    },
  );
}
