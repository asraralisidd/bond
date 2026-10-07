/**
 * Delegation domain: agent-to-agent bounded authority (Phase 23).
 *
 * A delegation lets agent A (delegator) authorize agent B (delegate)
 * to exercise specific AUTHENTICATION capabilities — the same
 * capabilities agent credentials carry (activity:submit, agent:read,
 * risk:read, verification:read, reputation:read). It NEVER grants
 * enforcement, withdrawal, policy-write, or credential-management
 * authority: those routes require operator principals, which no
 * delegation can mint.
 *
 * Core invariant (enforced server-side, never trusted from clients):
 * a delegator cannot delegate authority it does not possess.
 *
 * "Delegation grants authority within a bounded scope; it does not
 * grant authority beyond the delegator's existing capabilities."
 *
 * Pure module: no I/O, no clock (callers pass nowMs), no randomness.
 */
import { DomainError } from "./errors.js";

/** Protocol/version tag for delegation records and events. */
export const DELEGATION_VERSION = "delegation-v1" as const;

/**
 * Capabilities that may appear in a delegation. Closed set: the
 * authentication capabilities only. Anything else (enforcement,
 * bond:withdraw, policy:write, credential:manage, setup grants)
 * is rejected at creation — privilege escalation fails closed.
 */
export const DELEGABLE_CAPABILITIES = [
  "activity:submit",
  "agent:read",
  "risk:read",
  "verification:read",
  "reputation:read",
] as const;

export type DelegableCapability = (typeof DELEGABLE_CAPABILITIES)[number];

/** Stored lifecycle states. Expiry is evaluated dynamically. */
export type DelegationStatus = "active" | "revoked" | "expired";

/** Maximum delegation lifetime (90 days, mirrors credential policy). */
export const DELEGATION_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface DelegationScopeInput {
  readonly actionTypes?: readonly string[];
  readonly tools?: readonly string[];
  readonly models?: readonly string[];
  readonly providers?: readonly string[];
}

export interface ResolvedDelegationScope {
  readonly actionTypes: readonly string[] | null;
  readonly tools: readonly string[] | null;
  readonly models: readonly string[] | null;
  readonly providers: readonly string[] | null;
}

const MAX_SCOPE_ENTRIES = 100;
const MAX_SCOPE_ENTRY_LENGTH = 128;

function fail(field: string, value: unknown): never {
  throw new DomainError("INVALID_DELEGATION", `Invalid delegation: ${field}`, {
    field,
    value,
  });
}

function resolveScopeList(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_SCOPE_ENTRIES) {
    fail(field, value);
  }
  const seen = new Set<string>();
  for (const entry of value as readonly unknown[]) {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > MAX_SCOPE_ENTRY_LENGTH
    ) {
      fail(field, entry);
    }
    seen.add(entry as string);
  }
  return [...seen];
}

/** Validates scope bounds. Null/absent dimensions are unconstrained. */
export function validateDelegationScope(
  raw: DelegationScopeInput | undefined,
): ResolvedDelegationScope {
  if (raw === undefined) {
    return { actionTypes: null, tools: null, models: null, providers: null };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("scope", raw);
  }
  const input = raw as DelegationScopeInput;
  return {
    actionTypes: resolveScopeList(input.actionTypes, "scope.actionTypes"),
    tools: resolveScopeList(input.tools, "scope.tools"),
    models: resolveScopeList(input.models, "scope.models"),
    providers: resolveScopeList(input.providers, "scope.providers"),
  };
}

/** Validates a delegation capability list against the closed set. */
export function validateDelegationCapabilities(
  capabilities: unknown,
): DelegableCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    fail("capabilities", capabilities);
  }
  const seen = new Set<DelegableCapability>();
  for (const entry of capabilities as unknown[]) {
    if (
      typeof entry !== "string" ||
      !(DELEGABLE_CAPABILITIES as readonly string[]).includes(entry)
    ) {
      fail("capabilities", entry);
    }
    seen.add(entry as DelegableCapability);
  }
  return [...seen];
}

/** Validates expiry: future-dated and within the maximum TTL. */
export function validateDelegationExpiry(
  expiresAt: unknown,
  nowMs: number,
): string {
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    fail("expiresAt", expiresAt);
  }
  const ms = Date.parse(expiresAt as string);
  if (ms <= nowMs || ms > nowMs + DELEGATION_MAX_TTL_MS) {
    fail("expiresAt", expiresAt);
  }
  return expiresAt as string;
}

/**
 * Effective status: stored revocation wins; otherwise expiry is
 * evaluated against the caller-supplied clock. The timestamp —
 * never the stored flag alone — is the security authority.
 */
export function effectiveDelegationStatus(input: {
  readonly status: string;
  readonly expiresAt: string;
  readonly nowMs: number;
}): DelegationStatus {
  if (input.status === "revoked") {
    return "revoked";
  }
  return Date.parse(input.expiresAt) <= input.nowMs ? "expired" : "active";
}

export type DelegationDenyReason =
  | "wrong-delegate"
  | "revoked"
  | "expired"
  | "capability-not-delegated"
  | "delegator-lacks-capability"
  | "scope-exceeded";

export interface DelegationUseInput {
  /** Authenticated agent attempting the operation (must be delegate). */
  readonly delegateAgentId: string;
  readonly requiredCapability: string;
  readonly delegation: {
    readonly delegateAgentId: string;
    readonly status: string;
    readonly expiresAt: string;
    readonly capabilities: readonly string[];
    readonly scope: ResolvedDelegationScope;
  };
  /** Delegator's live capabilities (server-resolved, never trusted). */
  readonly delegatorCapabilities: readonly string[];
  /** Operation under test (null when only capability is checked). */
  readonly operation: {
    readonly actionType?: string | null;
    readonly tool?: string | null;
    readonly model?: string | null;
    readonly provider?: string | null;
  } | null;
  readonly nowMs: number;
}

export type DelegationAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DelegationDenyReason };

function scopeAllows(
  allowed: readonly string[] | null,
  value: string | null | undefined,
): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return allowed === null || allowed.includes(value);
}

/**
 * Centralized authorization predicate. Checks, in order: delegate
 * identity → revocation → expiry → capability in delegation →
 * delegator live possession → operation scope. First failure wins;
 * callers audit the reason and return generic 403s.
 */
export function authorizeDelegation(
  input: DelegationUseInput,
): DelegationAuthResult {
  const { delegation } = input;
  if (delegation.delegateAgentId !== input.delegateAgentId) {
    return { ok: false, reason: "wrong-delegate" };
  }
  const status = effectiveDelegationStatus({
    status: delegation.status,
    expiresAt: delegation.expiresAt,
    nowMs: input.nowMs,
  });
  if (status === "revoked") {
    return { ok: false, reason: "revoked" };
  }
  if (status === "expired") {
    return { ok: false, reason: "expired" };
  }
  if (!delegation.capabilities.includes(input.requiredCapability)) {
    return { ok: false, reason: "capability-not-delegated" };
  }
  if (!input.delegatorCapabilities.includes(input.requiredCapability)) {
    return { ok: false, reason: "delegator-lacks-capability" };
  }
  const op = input.operation;
  if (op !== null) {
    const scope = delegation.scope;
    if (
      !scopeAllows(scope.actionTypes, op.actionType) ||
      !scopeAllows(scope.tools, op.tool) ||
      !scopeAllows(scope.models, op.model) ||
      !scopeAllows(scope.providers, op.provider)
    ) {
      return { ok: false, reason: "scope-exceeded" };
    }
  }
  return { ok: true };
}

export interface DelegationAttribution {
  /** Authority source (delegator), or the executor when direct. */
  readonly requesterAgentId: string;
  /** Agent that actually executed the operation. */
  readonly executorAgentId: string;
  /** Authorizing delegation, or null for direct activity. */
  readonly delegationId: string | null;
}

/**
 * Attribution derivation. The executor is NEVER replaced by the
 * delegator: both identities survive, plus the delegation that
 * authorized the operation. Server-side only — clients cannot
 * assert requester identity.
 */
export function deriveAttribution(input: {
  readonly executorAgentId: string;
  readonly delegation: {
    readonly id: string;
    readonly delegatorAgentId: string;
  } | null;
}): DelegationAttribution {
  if (input.delegation === null) {
    return {
      requesterAgentId: input.executorAgentId,
      executorAgentId: input.executorAgentId,
      delegationId: null,
    };
  }
  return {
    requesterAgentId: input.delegation.delegatorAgentId,
    executorAgentId: input.executorAgentId,
    delegationId: input.delegation.id,
  };
}
