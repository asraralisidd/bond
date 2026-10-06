/**
 * Backend configuration: environment parsing with fail-fast validation.
 *
 * Fail-closed rules:
 * - DATABASE_URL is always required.
 * - NODE_ENV must be development, test, or production.
 * - Production requires explicit CORS_ORIGINS (no silent localhost
 *   fallback) and forbids DEV_AUTH_TOKEN (dev auth must never run in
 *   prod) and wildcard origins (with or without credentials).
 * - Secrets are never defaulted and never logged. Wallet material is
 *   never read here.
 */
export type NodeEnv = "development" | "test" | "production";

export interface ApiConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: readonly string[];
  readonly bodyLimit: string;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly databaseUrl: string;
  readonly logLevel: string;
  readonly midnightNetwork: string;
  readonly devAuthToken: string | null;
  readonly pgConnectTimeoutMs: number;
  readonly pgIdleTimeoutMs: number;
  readonly pgStatementTimeoutMs: number;
  readonly pgPoolMax: number;
  readonly idempotencyTtlHours: number;
  readonly workerEnabled: boolean;
  readonly workerConcurrency: number;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseMs: number;
  readonly workerMaxAttempts: number;
  readonly workerBackoffBaseMs: number;
  readonly workerBackoffMaxMs: number;
  readonly workerSubmittedReconcileAfterMs: number;
  readonly workerReconcileIntervalMs: number;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNodeEnv(env: NodeJS.ProcessEnv): NodeEnv {
  const raw = (env.NODE_ENV ?? "development").trim();
  if (raw === "development" || raw === "test" || raw === "production") {
    return raw;
  }
  throw new Error(`Invalid NODE_ENV: ${raw}`);
}

function parseCorsOrigins(env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): string[] {
  const raw = env.CORS_ORIGINS?.trim() || env.CORS_ORIGIN?.trim() || "";
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (origins.includes("*")) {
    throw new Error("CORS origins must never include '*'");
  }
  if (nodeEnv === "production" && origins.length === 0) {
    throw new Error(
      "Production requires explicit CORS_ORIGINS (comma-separated)",
    );
  }
  if (origins.length === 0) {
    return ["http://localhost:5173"];
  }
  return origins;
}

function parseBodyLimit(env: NodeJS.ProcessEnv): string {
  const raw = (env.BODY_LIMIT ?? "100kb").trim().toLowerCase();
  if (!/^(\d+)(b|kb|mb)$/.test(raw)) {
    throw new Error(`Invalid BODY_LIMIT: ${env.BODY_LIMIT}`);
  }
  const [, amount, unit] = /^(\d+)(b|kb|mb)$/.exec(raw) as RegExpExecArray;
  const bytes =
    Number(amount) * (unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1);
  if (bytes <= 0 || bytes > 5 * 1024 * 1024) {
    throw new Error(`Invalid BODY_LIMIT: ${env.BODY_LIMIT}`);
  }
  return raw;
}

function parsePositiveInt(
  name: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseLogLevel(env: NodeJS.ProcessEnv): string {
  const raw = (env.LOG_LEVEL ?? "info").trim().toLowerCase();
  const allowed = [
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ];
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid LOG_LEVEL: ${env.LOG_LEVEL}`);
  }
  return raw;
}

function parsePositiveIntEnv(
  name: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseWorkerFlag(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.WORKER_ENABLED ?? "true").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }
  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }
  throw new Error(`Invalid WORKER_ENABLED: ${env.WORKER_ENABLED}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = parseNodeEnv(env);
  const portRaw = env.API_PORT ?? "4000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid API_PORT: ${portRaw}`);
  }
  const devAuthToken = env.DEV_AUTH_TOKEN?.trim() || null;
  if (nodeEnv === "production" && devAuthToken !== null) {
    throw new Error(
      "DEV_AUTH_TOKEN must not be set in production (development auth is disabled there)",
    );
  }
  // Phase 11: production MUST declare its Midnight network explicitly.
  // An empty MIDNIGHT_NETWORK would silently mean SIMULATED — a config
  // mistake must never make test traffic look like a real deployment.
  const midnightNetwork = env.MIDNIGHT_NETWORK ?? "";
  if (nodeEnv === "production" && midnightNetwork.trim() === "") {
    throw new Error(
      "MIDNIGHT_NETWORK must be set explicitly in production (empty means SIMULATED)",
    );
  }
  const shutdownTimeoutMs = parsePositiveInt("SHUTDOWN_TIMEOUT_MS", env, 10000);
  if (shutdownTimeoutMs <= 0) {
    throw new Error("Invalid SHUTDOWN_TIMEOUT_MS: must be > 0");
  }
  return {
    nodeEnv,
    port,
    host: env.API_HOST ?? "0.0.0.0",
    corsOrigins: parseCorsOrigins(env, nodeEnv),
    bodyLimit: parseBodyLimit(env),
    requestTimeoutMs: parsePositiveInt("REQUEST_TIMEOUT_MS", env, 30000),
    shutdownTimeoutMs,
    databaseUrl: required("DATABASE_URL", env),
    logLevel: parseLogLevel(env),
    midnightNetwork,
    devAuthToken,
    pgConnectTimeoutMs: parsePositiveIntEnv("PG_CONNECT_TIMEOUT_MS", env, 5000),
    pgIdleTimeoutMs: parsePositiveIntEnv("PG_IDLE_TIMEOUT_MS", env, 30000),
    pgStatementTimeoutMs: parsePositiveIntEnv(
      "PG_STATEMENT_TIMEOUT_MS",
      env,
      30000,
    ),
    pgPoolMax: parsePositiveIntEnv("PG_POOL_MAX", env, 10),
    idempotencyTtlHours: parsePositiveIntEnv("IDEMPOTENCY_TTL_HOURS", env, 24),
    workerEnabled: parseWorkerFlag(env),
    workerConcurrency: parsePositiveIntEnv("WORKER_CONCURRENCY", env, 5),
    workerPollIntervalMs: parsePositiveIntEnv(
      "WORKER_POLL_INTERVAL_MS",
      env,
      5000,
    ),
    workerLeaseMs: parsePositiveIntEnv("WORKER_LEASE_MS", env, 60000),
    workerMaxAttempts: parsePositiveIntEnv("WORKER_MAX_ATTEMPTS", env, 5),
    workerBackoffBaseMs: parsePositiveIntEnv(
      "WORKER_BACKOFF_BASE_MS",
      env,
      1000,
    ),
    workerBackoffMaxMs: parsePositiveIntEnv(
      "WORKER_BACKOFF_MAX_MS",
      env,
      60000,
    ),
    workerSubmittedReconcileAfterMs: parsePositiveIntEnv(
      "WORKER_SUBMITTED_RECONCILE_AFTER_MS",
      env,
      300000,
    ),
    workerReconcileIntervalMs: parsePositiveIntEnv(
      "WORKER_RECONCILE_INTERVAL_MS",
      env,
      60000,
    ),
  };
}
