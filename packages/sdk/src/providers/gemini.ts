/**
 * Gemini usage normalization.
 *
 * [VERIFY-PROVIDER]: follows the public Gemini
 * `GenerateContentResponse` shape —
 * `usageMetadata.promptTokenCount / candidatesTokenCount /
 * totalTokenCount`. Responses do not reliably echo the model, so
 * callers should pass `model` explicitly. No Google package import.
 */
import { normalizeUsage } from "./usage.js";
import type { NormalizedModelUsage } from "./usage.js";

export function normalizeGeminiUsage(
  response: unknown,
  options: { model?: string } = {},
): NormalizedModelUsage {
  return normalizeUsage("gemini", response, {
    model: options.model,
    inputKeys: ["promptTokenCount", "prompt_token_count"],
    outputKeys: ["candidatesTokenCount", "candidates_token_count"],
    totalKeys: ["totalTokenCount", "total_token_count"],
  });
}
