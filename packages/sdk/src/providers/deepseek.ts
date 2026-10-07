/**
 * DeepSeek usage normalization.
 *
 * [VERIFY-PROVIDER]: DeepSeek exposes an OpenAI-compatible chat API,
 * so the envelope mirrors OpenAI. Kept separate so future divergence
 * only touches this module. No provider package import.
 */
import { normalizeUsage } from "./usage.js";
import type { NormalizedModelUsage } from "./usage.js";

export function normalizeDeepSeekUsage(
  response: unknown,
  options: { model?: string } = {},
): NormalizedModelUsage {
  return normalizeUsage("deepseek", response, {
    model: options.model,
    inputKeys: ["prompt_tokens"],
    outputKeys: ["completion_tokens"],
    totalKeys: ["total_tokens"],
  });
}
