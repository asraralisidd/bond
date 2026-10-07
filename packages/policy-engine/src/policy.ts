/**
 * Agent policy domain (Phase 22).
 *
 * An AgentPolicy is operator-owned, versioned, and immutable once
 * superseded: changes always create a new version (see the API
 * layer), so history is the audit trail. Field semantics:
 *
 * - Allow/deny lists: null/undefined = unconstrained. A present
 *   list — even empty — is enforced as given (empty allowed =
 *   deny-all). Deny always wins over allow.
 * - Limits: null = unconstrained. Token/request/window counts are
 *   integers; money stays digit strings (opaque minor units).
 * - Windowed pairs must travel together: a per-window limit without
 *   its window (or vice versa) is rejected, never defaulted.
 *
 * No secrets may appear in a policy. Ever.
 */
import { DomainError } from "@bond/shared-types";

export type AgentPolicyStatus = "active" | "superseded";

export interface AgentPolicyInput {
  readonly allowedActions?: readonly string[];
  readonly deniedActions?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly allowedProviders?: readonly string[];
  readonly deniedProviders?: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxTotalTokensPerWindow?: number;
  readonly tokenWindowSeconds?: number;
  readonly maxRequestsPerWindow?: number;
  readonly requestWindowSeconds?: number;
  readonly maxCostMinorUnitsPerRequest?: string;
  readonly maxCostMinorUnitsPerWindow?: string;
  readonly costWindowSeconds?: number;
  readonly maxTransferMinorUnits?: string;
}

export interface ResolvedAgentPolicy {
  readonly version: number;
  readonly status: AgentPolicyStatus;
  readonly allowedActions: readonly string[] | null;
  readonly deniedActions: readonly string[];
  readonly allowedTools: readonly string[] | null;
  readonly deniedTools: readonly string[];
  readonly allowedProviders: readonly string[] | null;
  readonly deniedProviders: readonly string[];
  readonly allowedModels: readonly string[] | null;
  readonly deniedModels: readonly string[];
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly maxTotalTokens: number | null;
  readonly maxTotalTokensPerWindow: number | null;
  readonly tokenWindowSeconds: number | null;
  readonly maxRequestsPerWindow: number | null;
  readonly requestWindowSeconds: number | null;
  readonly maxCostMinorUnitsPerRequest: string | null;
  readonly maxCostMinorUnitsPerWindow: string | null;
  readonly costWindowSeconds: number | null;
  readonly maxTransferMinorUnits: string | null;
}

const MAX_LIST_ENTRIES = 100;
const MAX_LIST_ENTRY_LENGTH = 128;
const MAX_TOKENS = 1_000_000_000;
const MAX_REQUESTS = 1_000_000;
const MIN_WINDOW_SECONDS = 60;
const MAX_WINDOW_SECONDS = 2_592_000;
const MAX_COST_DIGITS = 30;

function fail(field: string, value: unknown): never {
  throw new DomainError("INVALID_POLICY", `Invalid policy: ${field}`, {
    field,
    value,
  });
}

function resolveList(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    fail(field, value);
  }
  const seen = new Set<string>();
  for (const entry of value as readonly unknown[]) {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > MAX_LIST_ENTRY_LENGTH
    ) {
      fail(field, entry);
    }
    seen.add(entry as string);
  }
  return [...seen];
}

function resolveCount(
  value: number | undefined,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(field, value);
  }
  return value as number;
}

function resolveCost(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_COST_DIGITS ||
    !/^[0-9]+$/.test(value)
  ) {
    fail(field, value);
  }
  return value;
}

/**
 * Validates raw policy input into resolved fields (version/status
 * assigned by the persistence layer). Windowed pairs are all-or-
 * nothing: a limit without its window, or a window without its
 * limit, fails closed. Throws INVALID_POLICY (400 at the API).
 */
export function validatePolicyInput(
  raw: AgentPolicyInput | undefined,
): Omit<ResolvedAgentPolicy, "version" | "status"> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("policy", raw);
  }
  const input = raw as AgentPolicyInput;
  const maxTotalTokensPerWindow = resolveCount(
    input.maxTotalTokensPerWindow,
    "maxTotalTokensPerWindow",
    1,
    MAX_TOKENS,
  );
  const tokenWindowSeconds = resolveCount(
    input.tokenWindowSeconds,
    "tokenWindowSeconds",
    MIN_WINDOW_SECONDS,
    MAX_WINDOW_SECONDS,
  );
  const maxRequestsPerWindow = resolveCount(
    input.maxRequestsPerWindow,
    "maxRequestsPerWindow",
    1,
    MAX_REQUESTS,
  );
  const requestWindowSeconds = resolveCount(
    input.requestWindowSeconds,
    "requestWindowSeconds",
    MIN_WINDOW_SECONDS,
    MAX_WINDOW_SECONDS,
  );
  const maxCostMinorUnitsPerWindow = resolveCost(
    input.maxCostMinorUnitsPerWindow,
    "maxCostMinorUnitsPerWindow",
  );
  const costWindowSeconds = resolveCount(
    input.costWindowSeconds,
    "costWindowSeconds",
    MIN_WINDOW_SECONDS,
    MAX_WINDOW_SECONDS,
  );
  const pairs: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [maxTotalTokensPerWindow, tokenWindowSeconds, "token"],
    [maxRequestsPerWindow, requestWindowSeconds, "request"],
    [maxCostMinorUnitsPerWindow, costWindowSeconds, "cost"],
  ];
  for (const [limit, window, name] of pairs) {
    if ((limit === null) !== (window === null)) {
      fail(
        `${name}Window`,
        `Windowed ${name} limits require both limit and window seconds`,
      );
    }
  }
  return {
    allowedActions: resolveList(input.allowedActions, "allowedActions"),
    deniedActions: resolveList(input.deniedActions, "deniedActions") ?? [],
    allowedTools: resolveList(input.allowedTools, "allowedTools"),
    deniedTools: resolveList(input.deniedTools, "deniedTools") ?? [],
    allowedProviders: resolveList(input.allowedProviders, "allowedProviders"),
    deniedProviders:
      resolveList(input.deniedProviders, "deniedProviders") ?? [],
    allowedModels: resolveList(input.allowedModels, "allowedModels"),
    deniedModels: resolveList(input.deniedModels, "deniedModels") ?? [],
    maxInputTokens: resolveCount(
      input.maxInputTokens,
      "maxInputTokens",
      1,
      MAX_TOKENS,
    ),
    maxOutputTokens: resolveCount(
      input.maxOutputTokens,
      "maxOutputTokens",
      1,
      MAX_TOKENS,
    ),
    maxTotalTokens: resolveCount(
      input.maxTotalTokens,
      "maxTotalTokens",
      1,
      MAX_TOKENS,
    ),
    maxTotalTokensPerWindow,
    tokenWindowSeconds,
    maxRequestsPerWindow,
    requestWindowSeconds,
    maxCostMinorUnitsPerRequest: resolveCost(
      input.maxCostMinorUnitsPerRequest,
      "maxCostMinorUnitsPerRequest",
    ),
    maxCostMinorUnitsPerWindow,
    costWindowSeconds,
    maxTransferMinorUnits: resolveCost(
      input.maxTransferMinorUnits,
      "maxTransferMinorUnits",
    ),
  };
}
