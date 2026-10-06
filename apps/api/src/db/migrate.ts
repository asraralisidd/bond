/**
 * Minimal SQL migration runner (up-only).
 *
 * Applies database/migrations/NNN_*.sql in lexical order, tracking
 * applied files in schema_migrations. Each file runs in its own
 * transaction. No down migrations by design (forward-only audit trail).
 *
 * Concurrency: the whole discovery/application pass runs under a
 * transaction-scoped PostgreSQL advisory lock, so two API instances
 * starting simultaneously cannot apply the same migration twice. The
 * lock releases automatically on commit/rollback/disconnect — including
 * on failure, with no cleanup step that could itself fail.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/** Fixed advisory-lock key namespace for migrations (see docs/phase-9). */
export const MIGRATION_ADVISORY_LOCK = 7272718288;

export function migrationsDir(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "database",
    "migrations",
  );
}

export async function migrate(
  databaseUrl: string,
  dir: string = migrationsDir(),
): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const pool = new Pool({ connectionString: databaseUrl });
  const lockClient = await pool.connect();
  try {
    // Transaction-scoped advisory lock: held for the whole pass,
    // released automatically on COMMIT/ROLLBACK even on failure.
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT pg_advisory_xact_lock($1)", [
      MIGRATION_ADVISORY_LOCK,
    ]);
    try {
      await lockClient.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          filename TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      const rowsResult: { rows: { filename: string }[] } =
        await lockClient.query("SELECT filename FROM schema_migrations");
      const applied = new Set(rowsResult.rows.map((r) => r.filename));
      const ran: string[] = [];
      for (const file of files) {
        if (applied.has(file)) {
          continue;
        }
        const sql = readFileSync(join(dir, file), "utf8");
        await lockClient.query(sql);
        await lockClient.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        ran.push(file);
      }
      await lockClient.query("COMMIT");
      return ran;
    } catch (error) {
      try {
        await lockClient.query("ROLLBACK");
      } catch {
        // Lock releases with the session regardless.
      }
      throw error;
    }
  } finally {
    lockClient.release();
    await pool.end();
  }
}

const isMain = process.argv[1]?.endsWith("migrate.ts") ?? false;
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url)
    .then((ran) => {
      console.log(
        ran.length === 0
          ? "migrations: already up to date"
          : `migrations applied: ${ran.join(", ")}`,
      );
    })
    .catch((error: unknown) => {
      console.error("migration failed:", error);
      process.exit(1);
    });
}
