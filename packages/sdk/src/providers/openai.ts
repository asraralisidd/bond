/**
 * OpenAI usage normalization.
 *
 * [VERIFY-PROVIDER]: follows the public OpenAI chat completions
 * shape — `usage.prompt_tokens / completion_tokens / total_tokens`
 * with top-level `model` and `id`. No `openai` package import.
 */
import { normalizeUsage } from "./usage.js";
import type { NormalizedModelUsage } from "./usage.js";

export function normalizeOpenAIUsage(
  response: unknown,
  options: { model?: string } = {},
): NormalizedModelUsage {
  return normalizeUsage("openai", response, {
    model: options.model,
    inputKeys: ["prompt_tokens"],
    outputKeys: ["completion_tokens"],
    totalKeys: ["total_tokens"],
  });
}
