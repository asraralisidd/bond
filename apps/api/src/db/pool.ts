/**
 * PostgreSQL connection pool. Single pool per process; parameterized
 * queries only (enforced by review — this module exposes query/queryOne
 * helpers that take values arrays, never interpolated SQL).
 */
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;

export function getPool(databaseUrl?: string): Pool {
  if (pool !== null) {
    return pool;
  }
  const connectionString = databaseUrl ?? process.env.DATABASE_URL ?? undefined;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  pool = new Pool({ connectionString, max: 10 });
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

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}
