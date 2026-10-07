/**
 * Rate-limit policies: explicit per-category budgets.
 *
 * Values are initial operational defaults, not calibrated science —
 * generous enough for legitimate use (including the existing test
 * suite), tight enough to blunt floods and enumeration. Operators tune
 * them via environment; every value is validated at startup.
 *
 * Categories:
 * - auth: session issuance (strictest; keyed IP + credential target).
 * - public / publicEligibility: unauthenticated verification (moderate).
 * - read: authenticated reads (higher).
 * - mutation: authenticated state changes (lower).
 * - expensive: risk analysis and other heavy endpoints (strict).
 * - attestation: quorum/enforcement decisions (strict).
 * - transaction: tx create/advance/confirm (strict).
 */
import type { RateLimitPolicy } from "./store.js";

export type PolicyName =
  | "auth"
  | "public"
  | "publicEligibility"
  | "read"
  | "mutation"
  | "expensive"
  | "attestation"
  | "transaction";

export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly trustProxy: boolean;
  readonly maxKeys: number;
  readonly policies: Record<PolicyName, RateLimitPolicy>;
}

interface PolicyDefault {
  readonly max: number;
  readonly windowMs: number;
}

const DEFAULTS: Record<PolicyName, PolicyDefault> = {
  auth: { max: 30, windowMs: 10 * 60 * 1000 },
  public: { max: 200, windowMs: 60 * 1000 },
  publicEligibility: { max: 200, windowMs: 60 * 1000 },
  read: { max: 1000, windowMs: 60 * 1000 },
  mutation: { max: 200, windowMs: 60 * 1000 },
  expensive: { max: 100, windowMs: 60 * 1000 },
  attestation: { max: 60, windowMs: 60 * 1000 },
  transaction: { max: 60, windowMs: 60 * 1000 },
};

const ENV_KEYS: Record<PolicyName, { max: string; window: string }> = {
  auth: { max: "RATE_LIMIT_AUTH_MAX", window: "RATE_LIMIT_AUTH_WINDOW_MS" },
  public: {
    max: "RATE_LIMIT_PUBLIC_MAX",
    window: "RATE_LIMIT_PUBLIC_WINDOW_MS",
  },
  publicEligibility: {
    max: "RATE_LIMIT_PUBLIC_MAX",
    window: "RATE_LIMIT_PUBLIC_WINDOW_MS",
  },
  read: { max: "RATE_LIMIT_READ_MAX", window: "RATE_LIMIT_READ_WINDOW_MS" },
  mutation: {
    max: "RATE_LIMIT_MUTATION_MAX",
    window: "RATE_LIMIT_MUTATION_WINDOW_MS",
  },
  expensive: {
    max: "RATE_LIMIT_EXPENSIVE_MAX",
    window: "RATE_LIMIT_EXPENSIVE_WINDOW_MS",
  },
  attestation: {
    max: "RATE_LIMIT_ATTESTATION_MAX",
    window: "RATE_LIMIT_ATTESTATION_WINDOW_MS",
  },
  transaction: {
    max: "RATE_LIMIT_TX_MAX",
    window: "RATE_LIMIT_TX_WINDOW_MS",
  },
};

function parseBoundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseFlag(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid ${name}: ${raw}`);
}

function parseTrustProxy(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid TRUST_PROXY: ${raw}`);
}

export function resolveRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const policies = {} as Record<PolicyName, RateLimitPolicy>;
  (Object.keys(DEFAULTS) as PolicyName[]).forEach((name) => {
    if (name === "publicEligibility") {
      return;
    }
    const keys = ENV_KEYS[name];
    const defaults = DEFAULTS[name];
    policies[name] = {
      name,
      max: parseBoundedInt(keys.max, env[keys.max], defaults.max, 1, 1000000),
      windowMs: parseBoundedInt(
        keys.window,
        env[keys.window],
        defaults.windowMs,
        1000,
        86400000,
      ),
    };
  });
  policies.publicEligibility = {
    name: "publicEligibility",
    max: policies.public.max,
    windowMs: policies.public.windowMs,
  };
  return {
    enabled: parseFlag("RATE_LIMIT_ENABLED", env.RATE_LIMIT_ENABLED, true),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    maxKeys: parseBoundedInt(
      "RATE_LIMIT_MAX_KEYS",
      env.RATE_LIMIT_MAX_KEYS,
      10000,
      100,
      1000000,
    ),
    policies,
  };
}

/** Classify a request for the GLOBAL (pre-auth, IP-keyed) layer.
 *
 * Mutations and attestation/transaction writes return null here: they
 * are covered per-route after authentication with operator identity.
 * Reads get a generous IP baseline; auth and public traffic get their
 * own strict/moderate policies.
 */
export function classifyRequest(
  method: string,
  path: string,
): PolicyName | null {
  const upper = method.toUpperCase();
  if (upper === "OPTIONS") {
    return null;
  }
  if (path === "/health" || path === "/ready" || path === "/metrics") {
    return null;
  }
  if (path === "/api/v1/auth/session") {
    return "auth";
  }
  if (
    path === "/api/v1/auth/wallet/challenge" ||
    path === "/api/v1/auth/wallet/verify"
  ) {
    return "auth";
  }
  if (
    path.startsWith("/api/v1/public/agents/") &&
    path.endsWith("/eligibility")
  ) {
    return "publicEligibility";
  }
  if (path.startsWith("/api/v1/public/")) {
    return "public";
  }
  if (upper === "GET" || upper === "HEAD") {
    return path.startsWith("/api/v1/") ? "read" : null;
  }
  return null;
}
