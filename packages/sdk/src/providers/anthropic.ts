/**
 * Anthropic usage normalization.
 *
 * [VERIFY-PROVIDER]: follows the public Anthropic messages shape —
 * `usage.input_tokens / output_tokens` with top-level `model` and
 * `id`. No total is exposed; the shared core derives input+output
 * (documented derivation, not provider data). No `anthropic`
 * package import.
 */
import { normalizeUsage } from "./usage.js";
import type { NormalizedModelUsage } from "./usage.js";

export function normalizeAnthropicUsage(
  response: unknown,
  options: { model?: string } = {},
): NormalizedModelUsage {
  return normalizeUsage("anthropic", response, {
    model: options.model,
    inputKeys: ["input_tokens"],
    outputKeys: ["output_tokens"],
    totalKeys: ["total_tokens"],
  });
}
