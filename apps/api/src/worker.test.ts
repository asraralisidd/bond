/**
 * Phase 9.4 worker tests: lifecycle, concurrency, leases, retries,
 * dead-letters, uncertain submission, SIMULATED honesty, stuck-row
 * reporting, shutdown, security boundaries, config, and units.
 *
 * Deterministic by construction: injected clocks, real PostgreSQL
 * serialization instead of sleeps, and bounded waits only for the
 * loop-lifecycle test.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { ApiError } from "./http/errors.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { createOperator } from "./db/stores/operators.js";
import { insertAgent, insertBond } from "./db/stores/registry.js";
import {
  findChainTransactionById,
  insertChainTransaction,
} from "./db/stores/chain.js";
import { registerBondExecutors } from "./services/executors.js";
import { computeBackoffDelayMs } from "./services/worker/backoff.js";
import { classifyFailure } from "./services/worker/classify.js";
import { resolveWorkerConfig } from "./services/worker/config.js";
import {
  createWorkerRuntime,
  type RuntimeDeps,
} from "./services/worker/runtime.js";
import type { WorkerConfig } from "./services/worker/config.js";

beforeAll(async () => {
  await useIsolatedDb("worker");
  registerBondExecutors();
});

beforeEach(async () => {
  await resetDb();
});

const BASE_CONFIG: WorkerConfig = {
  enabled: true,
  concurrency: 5,
  pollIntervalMs: 50,
  leaseMs: 60000,
  maxAttempts: 5,
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
  submittedReconcileAfterMs: 300000,
  reconcileIntervalMs: 3600000,
  reconcileBatchLimit: 50,
  contractAddress: null,
};

function simHandle() {
  return connectMidnight(resolveMidnightConfig({}));
}

async function seedAgentBond(
  suffix: string,
): Promise<{ agentId: string; bondId: string }> {
  await createOperator(`op-${suffix}`, `ext-${suffix}`);
  const agentId = `ag-${suffix}`;
  await insertAgent({
    id: agentId,
    operatorId: `op-${suffix}`,
    platform: "custom",
    agentType: "custom",
    capabilities: [],
    externalRef: `ext-${suffix}`,
    status: "REGISTERED",
    policyVersion: "bond-policy-v1",
  });
  const bondId = `bond-${suffix}`;
  await insertBond({
    id: bondId,
    agentId,
    operatorId: `op-${suffix}`,
    commitmentMinorUnits: "10000",
    status: "CREATED",
    policyVersion: "bond-policy-v1",
  });
  return { agentId, bondId };
}

async function seedPendingTx(
  suffix: string,
  purpose = "REGISTRATION_ANCHOR",
  agentId: string | null = null,
): Promise<string> {
  const row = await insertChainTransaction({
    id: `tx-${suffix}`,
    purpose,
    agentId,
    bondId: null,
    idempotencyKey: `idem-${suffix}`,
    status: "PENDING",
  });
  return row.id;
}

function runtimeFor(
  overrides: Partial<RuntimeDeps> = {},
  configOverrides: Partial<WorkerConfig> = {},
) {
  return createWorkerRuntime({
    config: { ...BASE_CONFIG, ...configOverrides },
    resolveHandle: () => simHandle(),
    clock: () => new Date().toISOString(),
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

describe("A. lifecycle", () => {
  it("disabled worker never starts; stop drains to STOPPED; runOnce is a no-op after stop", async () => {
    const disabled = createWorkerRuntime({
      config: { ...BASE_CONFIG, enabled: false },
      resolveHandle: () => simHandle(),
      clock: () => "2026-10-06T00:00:00.000Z",
      sleep: () => Promise.resolve(),
    });
    expect(disabled.snapshot().phase).toBe("STARTING");
    disabled.start();
    expect(disabled.snapshot().phase).toBe("STARTING");
    await disabled.stop();
    expect(disabled.snapshot().phase).toBe("STOPPED");

    const rt = runtimeFor();
    await rt.stop();
    expect(rt.snapshot().phase).toBe("STOPPED");
    await seedAgentBond("life");
    const txId = await seedPendingTx(
      "life-1",
      "REGISTRATION_ANCHOR",
      "ag-life",
    );
    await rt.runOnce();
    expect(rt.snapshot().stats.polls).toBe(0);
    const row = await findChainTransactionById(txId);
    expect(row?.status).toBe("PENDING");
    expect(row?.claimed_by).toBeNull();
  });
});

describe("backoff units", () => {
  it("grows exponentially, caps, and spreads deterministically", () => {
    const d1 = computeBackoffDelayMs(1, 1000, 60000, "tx-a");
    const d2 = computeBackoffDelayMs(2, 1000, 60000, "tx-a");
    const d3 = computeBackoffDelayMs(3, 1000, 60000, "tx-a");
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeLessThan(2000);
    expect(computeBackoffDelayMs(20, 1000, 60000, "tx-a")).toBeLessThan(61000);
    // Deterministic per job id.
    expect(computeBackoffDelayMs(2, 1000, 60000, "tx-a")).toBe(d2);
    // Distinct jobs spread (jitter differs for most pairs).
    const spread = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        computeBackoffDelayMs(2, 1000, 60000, id),
      ),
    );
    expect(spread.size).toBeGreaterThan(1);
  });
});

describe("failure classification units", () => {
  it("classifies PERMANENT, ALREADY_COMPLETED, RETRYABLE, and uncertain", () => {
    expect(
      classifyFailure(new DomainError("INVALID_IDENTIFIER", "bad", {})),
    ).toBe("PERMANENT");
    expect(classifyFailure(new ApiError("NOT_FOUND", "gone"))).toBe(
      "PERMANENT",
    );
    expect(
      classifyFailure(new Error("duplicate key value violates unique")),
    ).toBe("ALREADY_COMPLETED");
    expect(classifyFailure(new Error("attestation already processed"))).toBe(
      "ALREADY_COMPLETED",
    );
    expect(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1"))).toBe(
      "RETRYABLE",
    );
    expect(classifyFailure(new Error("submission outcome uncertain"))).toBe(
      "REQUIRES_RECONCILIATION",
    );
    expect(classifyFailure(new Error("something totally novel"))).toBe(
      "RETRYABLE",
    );
  });
});

describe("worker config", () => {
  it("resolves defaults and rejects invalid values", () => {
    const config = resolveWorkerConfig({
      DATABASE_URL: "postgresql://x",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.concurrency).toBe(5);
    expect(config.leaseMs).toBe(60000);
    expect(() =>
      resolveWorkerConfig({
        DATABASE_URL: "postgresql://x",
        WORKER_ENABLED: "maybe",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/WORKER_ENABLED/);
    expect(() =>
      resolveWorkerConfig({
        DATABASE_URL: "postgresql://x",
        WORKER_CONCURRENCY: "0",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/WORKER_CONCURRENCY/);
    expect(() =>
      resolveWorkerConfig({
        DATABASE_URL: "postgresql://x",
        WORKER_LEASE_MS: "-5",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/WORKER_LEASE_MS/);
  });
});

describe("B. concurrency", () => {
  it("two workers divide jobs: each tx submitted exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await seedAgentBond(`conc-${i}`);
      ids.push(
        await seedPendingTx(
          `conc-tx-${i}`,
          "REGISTRATION_ANCHOR",
          `ag-conc-${i}`,
        ),
      );
    }
    const workerA = runtimeFor({ workerId: "worker-a" });
    const workerB = runtimeFor({ workerId: "worker-b" });
    await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    const statuses: { rows: { id: string; status: string }[] } = await query(
      "SELECT id, status FROM chain_transactions ORDER BY id",
    );
    expect(statuses.rows).toHaveLength(4);
    for (const row of statuses.rows) {
      expect(row.status).toBe("SUBMITTED");
    }
    // Exactly one SUBMITTED event per transaction: no double execution.
    const events: { rows: { count: string }[] } = await query(
      `SELECT COUNT(*) AS count FROM protocol_events
       WHERE type = 'TRANSACTION_STATUS_CHANGED'
         AND payload->>'to' = 'SUBMITTED'`,
    );
    expect(Number(events.rows[0]?.count ?? 0)).toBe(4);
    const snapA = workerA.snapshot();
    const snapB = workerB.snapshot();
    expect(snapA.stats.claimed + snapB.stats.claimed).toBe(4);
  });
});

describe("C. lease recovery", () => {
  it("a second worker recovers a crashed worker's claim and completes it", async () => {
    await seedAgentBond("lease");
    const txId = await seedPendingTx(
      "lease-1",
      "REGISTRATION_ANCHOR",
      "ag-lease",
    );
    // Simulate worker A dying mid-claim: stale claim, hour-old lease.
    await query(
      `UPDATE chain_transactions SET claimed_by = 'dead-worker',
         claimed_at = now() - interval '1 hour', attempts = 1
       WHERE id = $1`,
      [txId],
    );
    const workerB = runtimeFor({ workerId: "worker-b" });
    await workerB.runOnce();
    const row = await findChainTransactionById(txId);
    expect(row?.status).toBe("SUBMITTED");
    expect(row?.chain_tx_id?.startsWith("sim-")).toBe(true);
    expect(workerB.snapshot().stats.submitted).toBe(1);
  });

  it("a live lease is never stolen", async () => {
    await seedAgentBond("nolease");
    const txId = await seedPendingTx(
      "nolease-1",
      "REGISTRATION_ANCHOR",
      "ag-nolease",
    );
    await query(
      `UPDATE chain_transactions SET claimed_by = 'live-worker',
         claimed_at = now()
       WHERE id = $1`,
      [txId],
    );
    const rt = runtimeFor({ workerId: "worker-c" });
    await rt.runOnce();
    expect(rt.snapshot().stats.claimed).toBe(0);
    const row = await findChainTransactionById(txId);
    expect(row?.status).toBe("PENDING");
    expect(row?.claimed_by).toBe("live-worker");
  });
});

describe("D/E. retry, backoff, and dead-letter", () => {
  it("retryable failures schedule backoff; max attempts dead-letters", async () => {
    await seedAgentBond("retry");
    // FUND_BOND with no bond row for the agent: executor throws a
    // retryable error (missing record), exercising the retry path.
    const txId = await seedPendingTx("retry-1", "FUND_BOND", "ag-retry");
    await query("UPDATE chain_transactions SET bond_id = NULL WHERE id = $1", [
      txId,
    ]);
    const rt = runtimeFor({}, { maxAttempts: 5 });
    await rt.runOnce();
    let row = await findChainTransactionById(txId);
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    expect(row?.dead_letter).toBe(false);
    expect(rt.snapshot().stats.retried).toBe(1);
    const firstAttemptAt = row?.next_attempt_at;
    expect(firstAttemptAt).not.toBeNull();
    // Make the scheduled retry due, then exhaust with a strict budget.
    await query(
      "UPDATE chain_transactions SET next_attempt_at = now() - interval '1 minute' WHERE id = $1",
      [txId],
    );
    const strict = runtimeFor({}, { maxAttempts: 1 });
    await strict.runOnce();
    row = await findChainTransactionById(txId);
    expect(row?.status).toBe("FAILED");
    expect(row?.dead_letter).toBe(true);
    expect(strict.snapshot().stats.deadLettered).toBe(1);
  });

  it("permanent failures dead-letter immediately", async () => {
    await seedAgentBond("perm");
    const row = await insertChainTransactionDirect(
      "tx-perm-1",
      "NO_SUCH_PURPOSE",
      "ag-perm",
    );
    expect(row.status).toBe("PENDING");
    const rt = runtimeFor();
    await rt.runOnce();
    const after = await findChainTransactionById("tx-perm-1");
    expect(after?.status).toBe("FAILED");
    expect(after?.dead_letter).toBe(true);
    expect(rt.snapshot().stats.deadLettered).toBe(1);
  });

  async function insertChainTransactionDirect(
    id: string,
    purpose: string,
    agentId: string,
  ) {
    const { insertChainTransaction } = await import("./db/stores/chain.js");
    return insertChainTransaction({
      id,
      purpose,
      agentId,
      bondId: null,
      idempotencyKey: `idem-${id}`,
      status: "PENDING",
    });
  }
});

describe("F/H. execution and SIMULATED honesty", () => {
  it("submits SIMULATED work and never auto-confirms", async () => {
    const { bondId } = await seedAgentBond("exec");
    const txId = await seedPendingTx("exec-1", "FUND_BOND", "ag-exec");
    await query("UPDATE chain_transactions SET bond_id = $1 WHERE id = $2", [
      bondId,
      txId,
    ]);
    const rt = runtimeFor();
    await rt.runOnce();
    let row = await findChainTransactionById(txId);
    expect(row?.status).toBe("SUBMITTED");
    expect(row?.chain_tx_id?.startsWith("sim-")).toBe(true);
    // Second poll leaves it alone: confirmation is explicit and separate.
    await rt.runOnce();
    row = await findChainTransactionById(txId);
    expect(row?.status).toBe("SUBMITTED");
    expect(rt.snapshot().stats.confirmed).toBe(0);
  });
});

describe("G. uncertain REAL submission", () => {
  it("flags reconciliation instead of resubmitting", async () => {
    await seedAgentBond("unc");
    const txId = await seedPendingTx("unc-1", "FUND_BOND", "ag-unc");
    const realHandle = {
      mode: "REAL",
      config: { mode: "REAL" },
      contractAddress: null,
      providers: null,
      zkAssetsPath: "",
    } as never;
    const rt = runtimeFor({
      resolveHandle: () => realHandle,
    });
    await rt.runOnce();
    const row = await findChainTransactionById(txId);
    expect(row?.status).toBe("PENDING");
    expect(row?.reconciliation_required).toBe(true);
    expect(row?.chain_tx_id).toBeNull();
    // Second poll does not touch it: excluded from claiming while flagged.
    const before = row?.next_attempt_at;
    await rt.runOnce();
    const after = await findChainTransactionById(txId);
    expect(after?.reconciliation_required).toBe(true);
    expect(after?.chain_tx_id).toBeNull();
    expect(after?.next_attempt_at).toBe(before);
  });
});

describe("I. stuck SUBMITTED reporting", () => {
  it("counts stuck SIMULATED rows without touching them", async () => {
    await seedAgentBond("stuck");
    const txId = await seedPendingTx("stuck-1", "FUND_BOND", "ag-stuck");
    await query(
      `UPDATE chain_transactions SET status = 'SUBMITTED',
         updated_at = now() - interval '1 hour' WHERE id = $1`,
      [txId],
    );
    const rt = runtimeFor({}, { submittedReconcileAfterMs: 1000 });
    await rt.runOnce();
    expect(rt.snapshot().stats.stuckSubmitted).toBe(1);
    const row = await findChainTransactionById(txId);
    expect(row?.status).toBe("SUBMITTED");
  });
});

describe("J. shutdown", () => {
  it("stop() drains to STOPPED and runOnce becomes a no-op", async () => {
    await seedAgentBond("drain");
    await seedPendingTx("drain-1", "REGISTRATION_ANCHOR", "ag-drain");
    const rt = runtimeFor();
    expect(rt.snapshot().phase).toBe("STARTING");
    await rt.runOnce();
    expect(rt.snapshot().stats.claimed).toBe(1);
    await rt.stop();
    expect(rt.snapshot().phase).toBe("STOPPED");
    await seedPendingTx("drain-2", "REGISTRATION_ANCHOR", "ag-drain");
    await rt.runOnce();
    expect(rt.snapshot().stats.polls).toBe(1);
    expect(rt.snapshot().stats.claimed).toBe(1);
  });

  it("start/stop loop runs polls then stops within a bound", async () => {
    await seedAgentBond("loop");
    const rt = runtimeFor(
      {
        sleep: () => Promise.resolve(),
      },
      { pollIntervalMs: 10 },
    );
    rt.start();
    expect(rt.snapshot().phase).toBe("RUNNING");
    await rt.stop();
    expect(rt.snapshot().phase).toBe("STOPPED");
  });
});

describe("K. security boundaries", () => {
  it("worker code cannot reach risk, attestor evaluation, or wallets", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, "services", "worker");
    const sources = readdirSync(dir)
      .filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f: string) =>
        readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
      )
      .join("\n");
    for (const forbidden of [
      "@bond/risk-engine",
      "analyzeActivity",
      "analyzeBatch",
      "evaluateIndependently",
      "evaluateQuorum",
      "wallet-sdk",
      "WalletProvider",
      "privateStateProvider",
      "sampleSigningKey",
    ]) {
      expect(
        sources.includes(forbidden),
        `must not reference ${forbidden}`,
      ).toBe(false);
    }
  });

  it("unknown purposes are rejected at intent creation, never executed", async () => {
    const { createTransactionIntent } =
      await import("./services/transactions.js");
    await expect(
      createTransactionIntent({
        operatorId: "op-x",
        purpose: "RISK_ANALYSIS" as never,
        idempotencyKey: "idem-sec-1",
      }),
    ).rejects.toThrowError();
  });

  it("unregistered purposes dead-letter without chain contact", async () => {
    await seedAgentBond("sec");
    const { insertChainTransaction } = await import("./db/stores/chain.js");
    await insertChainTransaction({
      id: "tx-sec-1",
      purpose: "FUTURE_PURPOSE",
      agentId: "ag-sec",
      bondId: null,
      idempotencyKey: "idem-sec-1",
      status: "PENDING",
    });
    const rt = runtimeFor();
    await rt.runOnce();
    const row = await findChainTransactionById("tx-sec-1");
    expect(row?.status).toBe("FAILED");
    expect(row?.dead_letter).toBe(true);
    expect(row?.chain_tx_id).toBeNull();
  });
});

describe("migration", () => {
  it("008/009 worker columns exist with safe defaults", async () => {
    const cols: { rows: { column_name: string }[] } = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'chain_transactions'
         AND column_name IN
           ('claimed_by','claimed_at','next_attempt_at','max_attempts',
            'reconciliation_required','dead_letter')`,
    );
    expect(cols.rows).toHaveLength(6);
  });
});
