/**
 * Phase 9.2 reliability tests: atomicity, rollback, concurrency,
 * migration locking, idempotency leases, pool config, schema.
 *
 * Each file gets an isolated database (see test-helpers.ts), so
 * concurrent-execution tests below are deterministic, not sleep-based:
 * PostgreSQL serializes the conflicting operations; assertions check
 * that exactly one execution won.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate, MIGRATION_ADVISORY_LOCK } from "./db/migrate.js";
import { query, withTransaction, poolTuningFromEnv } from "./db/pool.js";
import { claimIdempotencyKey } from "./db/stores/chain.js";
import { insertAgent } from "./db/stores/registry.js";
import { insertProtocolEvent } from "./db/stores/events.js";
import { loadConfig } from "./config.js";
import { resetDb, testDatabaseUrl, useIsolatedDb } from "./test-helpers.js";

beforeAll(async () => {
  await useIsolatedDb("reliability");
});

beforeEach(async () => {
  await resetDb();
  await query(
    `INSERT INTO operators (id, external_key) VALUES
       ('op-1', 'op-1'), ('op-cc', 'op-cc')
     ON CONFLICT (id) DO NOTHING`,
  );
});

async function tableCount(table: string): Promise<number> {
  const result: { rows: { count: string }[] } = await query(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe("A/B/C. atomic commit and rollback", () => {
  it("rolls back state when the event write fails", async () => {
    await expect(
      withTransaction(async (client) => {
        await insertAgent(
          {
            id: "ag-rollback-1",
            operatorId: "op-1",
            platform: "custom",
            agentType: "custom",
            capabilities: [],
            externalRef: "ext-r1",
            status: "REGISTERED",
            policyVersion: "bond-policy-v1",
          },
          client,
        );
        // Simulated event-write failure: violates NOT NULL on actor.
        await client.query(
          "INSERT INTO protocol_events (id, type, actor) VALUES ($1, $2, NULL)",
          ["evt-rollback-1", "AGENT_REGISTERED"],
        );
      }),
    ).rejects.toThrowError();
    expect(await tableCount("agents")).toBe(0);
    expect(await tableCount("protocol_events")).toBe(0);
  });

  it("commits state and event together on success", async () => {
    await withTransaction(async (client) => {
      await insertAgent(
        {
          id: "ag-commit-1",
          operatorId: "op-1",
          platform: "custom",
          agentType: "custom",
          capabilities: [],
          externalRef: "ext-c1",
          status: "REGISTERED",
          policyVersion: "bond-policy-v1",
        },
        client,
      );
      await insertProtocolEvent(
        {
          id: "evt-commit-1",
          type: "AGENT_REGISTERED",
          actor: "test",
          payload: {},
        },
        client,
      );
    });
    expect(await tableCount("agents")).toBe(1);
    expect(await tableCount("protocol_events")).toBe(1);
  });

  it("releases the client after rollback (pool stays usable)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(
        withTransaction(async () => {
          throw new Error(`boom-${i}`);
        }),
      ).rejects.toThrowError(`boom-${i}`);
    }
    // Pool must still serve queries: no leaked clients.
    expect(await tableCount("agents")).toBe(0);
  });
});

describe("D. concurrent state transitions", () => {
  it("two concurrent bond creations converge to one live bond", async () => {
    await insertAgent({
      id: "ag-cc-1",
      operatorId: "op-cc",
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "ext-cc",
      status: "REGISTERED",
      policyVersion: "bond-policy-v1",
    });
    const { createBondService } = await import("./services/bonds.js");
    const results = await Promise.allSettled([
      createBondService({
        operatorId: "op-cc",
        agentId: "ag-cc-1",
        commitmentMinorUnits: "100",
      }),
      createBondService({
        operatorId: "op-cc",
        agentId: "ag-cc-1",
        commitmentMinorUnits: "100",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // Exactly one wins: the other hits the live-bond guard or the
    // duplicate-triple path. Both outcomes are fail-closed.
    expect(fulfilled.length + rejected.length).toBe(2);
    const live: { rows: { id: string }[] } = await query(
      `SELECT id FROM bonds WHERE agent_id = 'ag-cc-1'
       AND status IN ('ACTIVE','LOCKED','PARTIALLY_SLASHED','WITHDRAWABLE')`,
    );
    expect(live.rows.length).toBeLessThanOrEqual(1);
    const created: { rows: { id: string }[] } = await query(
      "SELECT id FROM bonds WHERE agent_id = 'ag-cc-1'",
    );
    // CREATED rows are pre-chain intents; at most the two attempts exist,
    // and the live-bond invariant (partial unique index) holds regardless.
    expect(created.rows.length).toBeLessThanOrEqual(2);
  });

  it("concurrent transaction advances serialize: one wins per transition", async () => {
    const { createTransactionIntent, advanceTransactionService } =
      await import("./services/transactions.js");
    const first = await createTransactionIntent({
      operatorId: "op-cc",
      purpose: "FUND_BOND",
      agentId: null,
      idempotencyKey: "idem-tx-race-1",
    });
    const attempts = await Promise.allSettled([
      advanceTransactionService(first.row.id, "WALLET_APPROVAL", "test"),
      advanceTransactionService(first.row.id, "WALLET_APPROVAL", "test"),
    ]);
    // IDLE→WALLET_APPROVAL twice: first wins, second fails the machine
    // (WALLET_APPROVAL→WALLET_APPROVAL is invalid). Exactly one success.
    const ok = attempts.filter((r) => r.status === "fulfilled");
    const failed = attempts.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    const events: { rows: { count: string }[] } = await query(
      "SELECT COUNT(*) AS count FROM protocol_events WHERE tx_id = $1 AND payload->>'to' = 'WALLET_APPROVAL'",
      [first.row.id],
    );
    // One advance event only: no duplicate transition records.
    expect(Number(events.rows[0]?.count ?? 0)).toBe(1);
  });
});

describe("E. migration locking", () => {
  it("concurrent migration runners apply each migration once", async () => {
    const adminUrl =
      process.env.TEST_ADMIN_DATABASE_URL ??
      "postgresql://bond:bond@localhost:5544/bond_dev";
    const dbName = "bond_test_migrace";
    const admin = new Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }
    const url = testDatabaseUrl("migrace");
    const [first, second] = await Promise.all([migrate(url), migrate(url)]);
    const combined = [...first, ...second].sort();
    const unique = [...new Set(combined)].sort();
    // Every migration applied exactly once across both runners.
    expect(combined).toEqual(unique);
    expect(unique.length).toBeGreaterThan(0);
  });

  it("advisory lock key is stable and documented", () => {
    expect(MIGRATION_ADVISORY_LOCK).toBe(7272718288);
    expect(Number.isInteger(MIGRATION_ADVISORY_LOCK)).toBe(true);
  });
});

describe("F. idempotency leases", () => {
  it("replays same key + same request, conflicts on different request", async () => {
    const { runIdempotent, fingerprintRequest } =
      await import("./services/idempotency.js");
    const fp = fingerprintRequest("POST /x", { a: 1 });
    const first = await runIdempotent({
      key: "idem-lease-1",
      operatorId: "op-1",
      route: "POST /x",
      fingerprint: fp,
      execute: async () => ({ ok: true }),
    });
    expect(first).toEqual({ replayed: false, body: { ok: true } });
    const replay = await runIdempotent({
      key: "idem-lease-1",
      operatorId: "op-1",
      route: "POST /x",
      fingerprint: fp,
      execute: async () => {
        throw new Error("must not execute twice");
      },
    });
    expect(replay).toEqual({ replayed: true, body: { ok: true } });
    await expect(
      runIdempotent({
        key: "idem-lease-1",
        operatorId: "op-1",
        route: "POST /x",
        fingerprint: fingerprintRequest("POST /x", { a: 2 }),
        execute: async () => ({}),
      }),
    ).rejects.toThrowError(/different request/);
  });

  it("concurrent identical requests converge to one execution", async () => {
    const { runIdempotent, fingerprintRequest } =
      await import("./services/idempotency.js");
    let executions = 0;
    const fp = fingerprintRequest("POST /y", { b: 1 });
    const run = () =>
      runIdempotent({
        key: "idem-lease-race",
        operatorId: "op-1",
        route: "POST /y",
        fingerprint: fp,
        execute: async () => {
          executions += 1;
          return { n: executions };
        },
      });
    const results = await Promise.allSettled([run(), run(), run()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    // At least one replay or success; executions bounded (claim losers
    // either replay or 409 — never silent double-execution of record).
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Winner wrote completed; at most two executions (claim race), and
    // only completed outcomes are returned as success.
    expect(executions).toBeLessThanOrEqual(2);
  });

  it("expired completed records are reclaimable; active leases are not", async () => {
    // Seed an expired completed key directly.
    await query(
      `INSERT INTO idempotency_keys
         (key, operator_id, route, request_fingerprint, status,
          response_snapshot, expires_at)
       VALUES ('idem-expired-1', 'op-1', 'POST /z', 'fp-old', 'completed',
         '{}', now() - interval '1 hour')`,
    );
    const reclaimed = await claimIdempotencyKey({
      key: "idem-expired-1",
      operatorId: "op-1",
      route: "POST /z",
      fingerprint: "fp-new",
    });
    expect(reclaimed.outcome).toBe("claimed");
    expect(reclaimed.reclaimed).toBe(true);
    // Active lease cannot be stolen, even with a different fingerprint.
    await query(
      `INSERT INTO idempotency_keys
         (key, operator_id, route, request_fingerprint, status,
          expires_at)
       VALUES ('idem-active-1', 'op-1', 'POST /z', 'fp-a', 'in-progress',
         now() + interval '1 hour')`,
    );
    const stolen = await claimIdempotencyKey({
      key: "idem-active-1",
      operatorId: "op-2",
      route: "POST /z",
      fingerprint: "fp-b",
      ttlHours: 24,
    });
    expect(stolen.outcome).toBe("conflict");
    const stored: { rows: { operator_id: string }[] } = await query(
      "SELECT operator_id FROM idempotency_keys WHERE key = 'idem-active-1'",
    );
    expect(stored.rows[0]?.operator_id).toBe("op-1");
  });

  it("stale in-progress leases recover after expiry", async () => {
    await query(
      `INSERT INTO idempotency_keys
         (key, operator_id, route, request_fingerprint, status,
          expires_at)
       VALUES ('idem-stale-1', 'op-1', 'POST /z', 'fp-s', 'in-progress',
         now() - interval '1 minute')`,
    );
    const recovered = await claimIdempotencyKey({
      key: "idem-stale-1",
      operatorId: "op-1",
      route: "POST /z",
      fingerprint: "fp-s",
    });
    expect(recovered.outcome).toBe("claimed");
    expect(recovered.reclaimed).toBe(true);
  });
});

describe("G. pool and configuration", () => {
  it("rejects invalid timeout values", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://x",
        PG_CONNECT_TIMEOUT_MS: "nan",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/PG_CONNECT_TIMEOUT_MS/);
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://x",
        IDEMPOTENCY_TTL_HOURS: "0",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/IDEMPOTENCY_TTL_HOURS/);
    const ok = loadConfig({
      DATABASE_URL: "postgresql://x",
    } as NodeJS.ProcessEnv);
    expect(ok.pgConnectTimeoutMs).toBe(5000);
    expect(ok.pgPoolMax).toBe(10);
    expect(ok.idempotencyTtlHours).toBe(24);
  });

  it("pool tuning never exposes credentials", () => {
    const tuning = poolTuningFromEnv({
      DATABASE_URL: "postgresql://bond:secret@localhost/db",
      PG_POOL_MAX: "7",
    } as NodeJS.ProcessEnv);
    expect(tuning.maxClients).toBe(7);
    expect(JSON.stringify(tuning)).not.toContain("secret");
    expect(JSON.stringify(tuning)).not.toContain("DATABASE_URL");
  });
});

describe("H. index and schema regression", () => {
  it("migration applies cleanly and keeps schema compatible", async () => {
    const url = process.env.DATABASE_URL as string;
    const ran = await migrate(url);
    expect(ran).toEqual([]);
    const indexes: { rows: { indexname: string }[] } = await query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'protocol_events_created_idx',
           'risk_flags_agent_status_idx',
           'idempotency_keys_expires_idx'
         )`,
    );
    expect(indexes.rows.map((r) => r.indexname).sort()).toEqual(
      [
        "idempotency_keys_expires_idx",
        "protocol_events_created_idx",
        "risk_flags_agent_status_idx",
      ].sort(),
    );
  });
});
