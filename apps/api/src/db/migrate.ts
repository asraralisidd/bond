/**
 * Minimal SQL migration runner (up-only).
 *
 * Applies database/migrations/NNN_*.sql in lexical order, tracking
 * applied files in schema_migrations. Each file runs in its own
 * transaction. No down migrations by design (forward-only audit trail).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

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
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const rowsResult: { rows: { filename: string }[] } = await pool.query(
      "SELECT filename FROM schema_migrations",
    );
    const applied = new Set(rowsResult.rows.map((r) => r.filename));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      ran.push(file);
    }
    return ran;
  } finally {
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
