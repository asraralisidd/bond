/**
 * Database backup script (Phase 15): safe pg_dump wrapper.
 *
 * Safety rules:
 * - child_process.execFile only (no shell, no string interpolation).
 * - Connection details come from DATABASE_URL, translated into libpq
 *   PG* environment variables for the child. The URL is NEVER printed,
 *   never placed on argv (process listings), and never echoed from
 *   child stderr (libpq errors can contain connection strings).
 * - Output goes to a configurable directory with a timestamped,
 *   filesystem-safe filename.
 * - Clear failures when pg_dump is missing or the dump fails.
 * - No restore automation here (restore is manual and documented in
 *   docs/ops-runbook.md — destructive restore must never be one
 *   command away from a backup).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/backup.mjs [--dir ./backups]
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function fail(message) {
  console.error(`backup: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let dir = "./backups";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") {
      const value = argv[i + 1];
      if (!value) {
        fail("missing value for --dir");
      }
      dir = value;
      i += 1;
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  return { dir };
}

/** Timestamp safe for filenames (no colons, no spaces). */
export function backupFilename(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `bond-db-${stamp}.dump`;
}

/**
 * Translate DATABASE_URL into libpq PG* variables (never argv).
 * Throws on missing/unparseable/non-postgres URLs.
 */
export function pgEnvFromDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use the postgresql: scheme.");
  }
  const env = {};
  if (parsed.hostname) {
    env.PGHOST = parsed.hostname;
  }
  if (parsed.port) {
    env.PGPORT = parsed.port;
  }
  if (parsed.username) {
    env.PGUSER = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    env.PGPASSWORD = decodeURIComponent(parsed.password);
  }
  const dbname = parsed.pathname.replace(/^\//, "");
  if (dbname) {
    env.PGDATABASE = decodeURIComponent(dbname);
  }
  return env;
}

/** pg_dump argv: array form only. Connection travels via environment. */
export function pgDumpArgs(outputPath) {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--file=${outputPath}`,
  ];
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  let pgEnv;
  try {
    pgEnv = pgEnvFromDatabaseUrl(process.env.DATABASE_URL);
  } catch (error) {
    fail(error.message ?? error);
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    fail(`cannot create output directory: ${error.message ?? error}`);
  }
  if (!existsSync(dir)) {
    fail("output directory is not accessible.");
  }
  const outputPath = join(dir, backupFilename());
  const child = execFile(
    "pg_dump",
    pgDumpArgs(outputPath),
    {
      env: { ...process.env, ...pgEnv },
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    },
    (error, _stdout, stderr) => {
      if (error) {
        // Never echo stderr verbatim: libpq errors can contain the
        // connection string. Report the failure class only.
        if (error.code === "ENOENT") {
          fail("pg_dump is not installed or not on PATH.");
        }
        fail("pg_dump failed (see database server logs for details).");
      } else if (stderr && stderr.length > 0) {
        console.error("backup: pg_dump reported warnings (details withheld).");
      }
      console.log(`backup: wrote ${outputPath}`);
    },
  );
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      fail("pg_dump is not installed or not on PATH.");
    }
    fail(`failed to start pg_dump: ${error.message ?? error}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
