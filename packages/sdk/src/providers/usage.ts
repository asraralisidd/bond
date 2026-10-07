/**
 * Provider-neutral model usage normalization (Phase 24).
 *
 * Pure mapping helpers translating provider response shapes into
 * BOND's normalized usage representation. No provider SDK imports,
 * no network, no credentials, no storage — callers pass
 * already-obtained response objects (plain data or objects with
 * readable fields).
 *
 * Security: only usage counters and model identifiers are
 * extracted. Prompts, completions, hidden reasoning, and API keys
 * are never read — unknown fields are ignored, never serialized.
 *
 * BOND does not store provider API keys.
 */
import { BondApiError } from "../errors.js";

export const MAX_SAFE_TOKENS = Number.MAX_SAFE_INTEGER;

export interface NormalizedModelUsage {
  readonly provider: string;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly estimatedCostMinorUnits: string | null;
  readonly providerRequestId: string | null;
}

function invalid(message: string): BondApiError {
  return new BondApiError("INVALID_ACTIVITY_INPUT", message, 0, null);
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(
      `Invalid provider usage: ${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function optionalTokens(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_TOKENS
  ) {
    throw invalid(
      `Invalid provider usage: ${field} must be a non-negative integer`,
    );
  }
  return value;
}

function optionalCost(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !/^[0-9]+$/.test(value) ||
    value.length > 30
  ) {
    throw invalid(`Invalid provider usage: ${field} must be a digit string`);
  }
  return value;
}

function optionalRequestId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(
      "Invalid provider usage: request id must be a non-empty string",
    );
  }
  return value.trim();
}

function readField(source: unknown, name: string): unknown {
  if (source === null || source === undefined) {
    return undefined;
  }
  if (typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (name in record) {
      return record[name];
    }
  }
  return undefined;
}

function readFirst(source: unknown, names: readonly string[]): unknown {
  for (const name of names) {
    const value = readField(source, name);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

export interface NormalizeUsageOptions {
  readonly model?: string;
  readonly modelKeys?: readonly string[];
  readonly inputKeys?: readonly string[];
  readonly outputKeys?: readonly string[];
  readonly totalKeys?: readonly string[];
  readonly costKeys?: readonly string[];
  readonly requestIdKeys?: readonly string[];
}

function usageBlock(source: unknown): unknown {
  if (source === null || source === undefined) {
    return undefined;
  }
  for (const key of ["usage", "usageMetadata", "usage_metadata"]) {
    const block = readField(source, key);
    if (block !== null && block !== undefined) {
      return block;
    }
  }
  return undefined;
}

/**
 * Shared core: extract and validate usage from a response envelope.
 *
 * Total rule (documented, deterministic): an explicitly supplied
 * total is kept as the provider's authority even when it disagrees
 * with input+output — never silently rewritten. When absent, the
 * total is derived as input+output only if at least one side is
 * present; otherwise it stays absent. Nothing is invented.
 */
export function normalizeUsage(
  provider: string,
  response: unknown,
  options: NormalizeUsageOptions = {},
): NormalizedModelUsage {
  const providerName = requireName(provider, "provider");
  if (response === null || response === undefined) {
    throw invalid("Invalid provider usage: response is required");
  }
  const block = usageBlock(response) ?? response;
  const modelKeys = options.modelKeys ?? [
    "model",
    "modelVersion",
    "model_version",
  ];
  let resolvedModel = options.model;
  if (resolvedModel === undefined) {
    for (const key of modelKeys) {
      const candidate = readField(response, key) ?? readField(block, key);
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        resolvedModel = candidate.trim();
        break;
      }
    }
  }
  const inputTokens = optionalTokens(
    readFirst(block, options.inputKeys ?? ["input_tokens"]),
    "input_tokens",
  );
  const outputTokens = optionalTokens(
    readFirst(block, options.outputKeys ?? ["output_tokens"]),
    "output_tokens",
  );
  let totalTokens = optionalTokens(
    readFirst(block, options.totalKeys ?? ["total_tokens"]),
    "total_tokens",
  );
  if (totalTokens === null && (inputTokens !== null || outputTokens !== null)) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  const cost = optionalCost(
    readFirst(block, options.costKeys ?? ["cost_minor_units", "cost"]),
    "cost",
  );
  const requestId = optionalRequestId(
    readFirst(
      response,
      options.requestIdKeys ?? ["id", "request_id", "requestId"],
    ),
  );
  return {
    provider: providerName,
    model: resolvedModel ?? null,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostMinorUnits: cost,
    providerRequestId: requestId,
  };
}
