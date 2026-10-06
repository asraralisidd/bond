/**
 * Readiness: verifies the dependencies this instance needs to serve
 * traffic. Liveness (/health) only proves the process is alive.
 *
 * Checks:
 * - PostgreSQL connectivity + required schema present (agents table).
 * - Midnight adapter mode declaration (SIMULATED is reported as-is and
 *   NEVER presented as a live network connection; REAL reports
 *   configured-but-unverified — verification requires a wallet and a
 *   live network, neither of which this endpoint can conjure).
 *
 * Responses contain booleans and mode names only — no credentials,
 * connection strings, URLs, or stack traces.
 */
import type { Request, Response } from "express";
import { Pool } from "pg";
import { resolveMidnightConfig } from "@bond/midnight-adapter";
import { getWorkerSnapshot } from "../../services/worker/registry.js";
import type { WorkerSnapshot } from "../../services/worker/types.js";

/** Null when no runtime exists here; never throws (readiness must not fail on it). */
function workerSnapshot(): {
  readonly enabled: boolean;
  readonly phase: string;
  readonly running: boolean;
  readonly draining: boolean;
  readonly lastPollAt: string | null;
  readonly activeJobs: number;
  readonly lastError: string | null;
} | null {
  let snapshot: WorkerSnapshot | null = null;
  try {
    snapshot = getWorkerSnapshot();
  } catch {
    return null;
  }
  if (!snapshot) {
    return null;
  }
  return {
    enabled: snapshot.enabled,
    phase: snapshot.phase,
    running: snapshot.phase === "RUNNING",
    draining: snapshot.phase === "DRAINING",
    lastPollAt: snapshot.stats.lastPollAt,
    activeJobs: snapshot.stats.activeJobs,
    lastError: snapshot.stats.lastError,
  };
}

export interface ReadinessCheck {
  readonly ready: boolean;
  readonly checks: {
    readonly database: { readonly ok: boolean; readonly schema: boolean };
    readonly midnight: {
      readonly mode: string;
      readonly network: string | null;
    };
    /**
     * Worker snapshot when a runtime exists in this process, else null
     * (worker disabled or never started). Safe fields only: no
     * credentials, URLs, amounts, nullifiers, or secrets.
     */
    readonly worker: {
      readonly enabled: boolean;
      readonly phase: string;
      readonly running: boolean;
      readonly draining: boolean;
      readonly lastPollAt: string | null;
      readonly activeJobs: number;
      readonly lastError: string | null;
    } | null;
  };
}

export async function checkReadiness(
  databaseUrl?: string,
  midnightNetwork?: string,
): Promise<ReadinessCheck> {
  let dbOk = false;
  let schemaOk = false;
  try {
    const pool = new Pool({
      connectionString: databaseUrl ?? process.env.DATABASE_URL ?? undefined,
      connectionTimeoutMillis: 3000,
    });
    try {
      await pool.query("SELECT 1");
      dbOk = true;
      const tables = await pool.query(
        `SELECT to_regclass('public.agents') AS agents,
                to_regclass('public.schema_migrations') AS migrations`,
      );
      const row = tables.rows[0] as {
        agents: string | null;
        migrations: string | null;
      };
      schemaOk = row.agents !== null && row.migrations !== null;
      if (schemaOk) {
        const applied = await pool.query(
          "SELECT COUNT(*) AS count FROM schema_migrations",
        );
        schemaOk = Number((applied.rows[0] as { count: string }).count) > 0;
      }
    } finally {
      await pool.end();
    }
  } catch {
    dbOk = false;
    schemaOk = false;
  }

  let mode = "UNKNOWN";
  let network: string | null = null;
  try {
    const config = resolveMidnightConfig(
      midnightNetwork !== undefined
        ? { MIDNIGHT_NETWORK: midnightNetwork }
        : process.env,
    );
    mode = config.mode;
    network = config.endpoints?.networkId ?? null;
  } catch {
    mode = "MISCONFIGURED";
  }

  return {
    ready: dbOk && schemaOk,
    checks: {
      database: { ok: dbOk, schema: schemaOk },
      midnight: { mode, network },
      worker: workerSnapshot(),
    },
  };
}

export async function readyHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const result = await checkReadiness();
  res.status(result.ready ? 200 : 503).json(result);
}
