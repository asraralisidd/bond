/**
 * API test harness: each test FILE gets an isolated database
 * (bond_test_<name>), migrated once, truncated between tests.
 * This keeps vitest file-level parallelism safe.
 */
import { Pool } from "pg";
import { migrate } from "./db/migrate.js";
import { query } from "./db/pool.js";

// CI-friendly parts override (defaults preserve local behavior).
const PG_USER = process.env.TEST_PG_USER ?? "bond";
const PG_PASSWORD = process.env.TEST_PG_PASSWORD ?? "bond";
const PG_HOST = process.env.TEST_PG_HOST ?? "localhost";
const PG_PORT = process.env.TEST_PG_PORT ?? "5544";

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/bond_dev`;

export function testDatabaseUrl(name = "shared"): string {
  return (
    process.env.TEST_DATABASE_URL ??
    `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/bond_test_${name}`
  );
}

/** Creates + migrates the file-local database (idempotent). */
export async function useIsolatedDb(name: string): Promise<string> {
  const url = testDatabaseUrl(name);
  const dbName = `bond_test_${name}`;
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  await migrate(url);
  process.env.DATABASE_URL = url;
  return url;
}

const TABLES = [
  "wallet_challenges",
  "sync_checkpoints",
  "protocol_events",
  "idempotency_keys",
  "chain_transactions",
  "nullifiers",
  "eligibility_proofs",
  "reputation_records",
  "slash_events",
  "attestations",
  "attestors",
  "risk_flags",
  "risk_analyses",
  "evidence_descriptors",
  "bonds",
  "agents",
  "sessions",
  "operators",
];

export async function resetDb(): Promise<void> {
  await query(`TRUNCATE ${TABLES.join(", ")} CASCADE`, []);
}
