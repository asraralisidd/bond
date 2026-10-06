/**
 * PostgreSQL connection pool. Single pool per process; parameterized
 * queries only (enforced by review — this module exposes query helpers
 * that take values arrays, never interpolated SQL).
 *
 * Timeouts (env-overridable, validated in config.ts):
 * - connectionTimeoutMillis: fail fast when no connection is available.
 * - idleTimeoutMillis: recycle idle clients.
 * - query_timeout: server-side cancel for runaway statements.
 * Pool errors are logged without connection details (no DATABASE_URL,
 * no credentials — the URL string is never interpolated into logs).
 */
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;

export interface PoolTuning {
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly queryTimeoutMillis: number;
  readonly maxClients: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid pool timeout value: ${raw}`);
  }
  return value;
}

export function poolTuningFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PoolTuning {
  return {
    connectionTimeoutMillis: positiveInt(env.PG_CONNECT_TIMEOUT_MS, 5000),
    idleTimeoutMillis: positiveInt(env.PG_IDLE_TIMEOUT_MS, 30000),
    queryTimeoutMillis: positiveInt(env.PG_STATEMENT_TIMEOUT_MS, 30000),
    maxClients: positiveInt(env.PG_POOL_MAX, 10),
  };
}

function onPoolError(error: unknown): void {
  // Deliberately minimal: pool errors carry no connection string here.
  const message = error instanceof Error ? error.message : "unknown";
  console.error(`pg pool error: ${message.slice(0, 300)}`);
}

export function getPool(databaseUrl?: string): Pool {
  if (pool !== null) {
    return pool;
  }
  const connectionString = databaseUrl ?? process.env.DATABASE_URL ?? undefined;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const tuning = poolTuningFromEnv();
  pool = new Pool({
    connectionString,
    max: tuning.maxClients,
    connectionTimeoutMillis: tuning.connectionTimeoutMillis,
    idleTimeoutMillis: tuning.idleTimeoutMillis,
    query_timeout: tuning.queryTimeoutMillis,
  });
  pool.on("error", onPoolError);
  return pool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  client?: PoolClient,
): Promise<QueryResult<T>> {
  if (client) {
    return client.query<T>(text, values as unknown[]);
  }
  return getPool().query<T>(text, values as unknown[]);
}

/**
 * Runs fn inside a single database transaction. Commits on success;
 * rolls back on any failure (including event-write failures, so state
 * and audit trail can never diverge). The client is always released.
 * No nested transactions: callers must not call withTransaction inside
 * an existing withTransaction callback (pass the client instead).
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure leaves nothing actionable; original error wins.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}
