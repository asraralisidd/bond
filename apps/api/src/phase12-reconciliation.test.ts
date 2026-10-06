/**
 * Phase 12 focused tests: transaction lifecycle truthfulness,
 * reconciliation against authoritative chain state, and the
 * non-custodial read-only provider seam.
 *
 * No live network is exercised here — these are deterministic unit /
 * integration tests that pin the contract between adapter, service,
 * worker, and DB. Live-network verification status is documented in
 * docs/phase-12/e2e-live-midnight.md.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { connectReadOnly, readTransactionStatus } from "@bond/midnight-adapter";
import type { ChainHandle } from "@bond/midnight-adapter";
import { reconcileTransactionRows } from "./services/reconcile.js";

const DEV_KEY = "test-dev-key";

async function sessionFor(
  app: ReturnType<typeof createApp>,
  externalKey: string,
) {
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey });
  expect(sess.status).toBe(201);
  return sess.body.token as string;
}

async function registerAgent(
  app: ReturnType<typeof createApp>,
  token: string,
  ref: string,
) {
  const res = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "p",
      agentType: "custom",
      capabilities: [],
      externalRef: ref,
    });
  expect(res.status).toBe(201);
  return res.body.data.agentId as string;
}

beforeAll(async () => {
  await useIsolatedDb("phase12");
});

beforeEach(async () => {
  await resetDb();
});

describe("advance bypass regression", () => {
  it("rejects advance to CONFIRMED without finality evidence", async () => {
    const app = createApp();
    const token = await sessionFor(app, "adv-bypass");
    const agentId = await registerAgent(app, token, "adv-bypass-a");
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "adv-bypass-1" });
    expect(created.status).toBe(201);
    const txId = created.body.data.transactionId as string;

    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      const adv = await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
      expect(adv.status).toBe(200);
    }

    const submitted = await request(app)
      .post(`/api/v1/transactions/${txId}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-adv" });
    expect(submitted.status).toBe(200);

    const bypass = await request(app)
      .post(`/api/v1/transactions/${txId}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "CONFIRMED" });
    expect(bypass.status).toBe(400);
    expect(bypass.body.code).toBe("INVALID_TRANSACTION_TRANSITION");

    const row: { rows: { status: string; confirmed_at: string | null }[] } =
      await query(
        "SELECT status, confirmed_at FROM chain_transactions WHERE id = $1",
        [txId],
      );
    expect(row.rows[0]?.status).toBe("SUBMITTED");
    expect(row.rows[0]?.confirmed_at).toBeNull();
  });

  it("rejects advance to FAILED without finality evidence", async () => {
    const app = createApp();
    const token = await sessionFor(app, "adv-fail");
    const agentId = await registerAgent(app, token, "adv-fail-a");
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "adv-fail-1" });
    const txId = created.body.data.transactionId as string;

    const fail = await request(app)
      .post(`/api/v1/transactions/${txId}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "FAILED" });
    expect(fail.status).toBe(400);
    expect(fail.body.code).toBe("INVALID_TRANSACTION_TRANSITION");
  });
});

describe("read-only provider seam", () => {
  it("refuses wallet/private-state operations by construction", () => {
    const handle = connectReadOnly({
      mode: "REAL",
      endpoints: {
        networkId: "undeployed",
        indexerHttp: "http://127.0.0.1:8088/api/v4/graphql",
        indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
        nodeUrl: "http://127.0.0.1:9944",
        proofServerUrl: "http://127.0.0.1:6300",
      },
      contractAddress: "addr-test",
      zkAssetsPath: "",
    });
    expect(handle.mode).toBe("REAL");
    expect(handle.providers).not.toBeNull();
    expect(() =>
      handle.providers!.walletProvider.getCoinPublicKey(),
    ).toThrowError(/Read-only providers hold no keys/);
    expect(() =>
      handle.providers!.midnightProvider.submitTx(null as never),
    ).toThrowError(/Read-only providers cannot submit transactions/);
    expect(() =>
      (
        handle.providers!.privateStateProvider as unknown as {
          set: (k: string, v: unknown) => void;
        }
      ).set("x", {}),
    ).toThrowError(/Read-only providers do not support set/);
  });

  it("rejects non-REAL configuration", () => {
    expect(() =>
      connectReadOnly({
        mode: "SIMULATED",
        endpoints: null,
        contractAddress: null,
        zkAssetsPath: "",
      }),
    ).toThrowError(/Read-only observation requires REAL/);
    expect(() =>
      connectReadOnly({
        mode: "UNAVAILABLE",
        endpoints: null,
        contractAddress: null,
        zkAssetsPath: "",
      }),
    ).toThrowError(/Midnight integration disabled/);
  });
});

describe("transaction-row reconciliation", () => {
  it("leaves SUBMITTED rows untouched when handle is not REAL", async () => {
    const app = createApp();
    const token = await sessionFor(app, "recon-sim");
    const agentId = await registerAgent(app, token, "recon-sim-a");
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "recon-sim-1" });
    const txId = created.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    await request(app)
      .post(`/api/v1/transactions/${txId}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "sim-ref-1" });

    const simHandle: ChainHandle = {
      mode: "SIMULATED",
      config: {
        mode: "SIMULATED",
        endpoints: null,
        contractAddress: null,
        zkAssetsPath: "",
      },
      contractAddress: null,
      providers: null,
      zkAssetsPath: "",
    };
    const report = await reconcileTransactionRows(simHandle, 10);
    expect(report.checked).toBe(0);
    expect(report.confirmed).toBe(0);
    expect(report.failed).toBe(0);

    const row: { rows: { status: string }[] } = await query(
      "SELECT status FROM chain_transactions WHERE id = $1",
      [txId],
    );
    expect(row.rows[0]?.status).toBe("SUBMITTED");
  });

  it("skips non-SUBMITTED rows and rows without chain references", async () => {
    const app = createApp();
    const token = await sessionFor(app, "recon-skip");
    const agentId = await registerAgent(app, token, "recon-skip-a");
    // IDLE row (no chain ref, not SUBMITTED).
    await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "recon-skip-1" });

    const handle = connectReadOnly({
      mode: "REAL",
      endpoints: {
        networkId: "undeployed",
        indexerHttp: "http://127.0.0.1:8088/api/v4/graphql",
        indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
        nodeUrl: "http://127.0.0.1:9944",
        proofServerUrl: "http://127.0.0.1:6300",
      },
      contractAddress: "addr-test",
      zkAssetsPath: "",
    });
    const report = await reconcileTransactionRows(handle, 10);
    expect(report.checked).toBe(0);
  });
});

describe("readTransactionStatus guardrails", () => {
  it("refuses on non-REAL handles", async () => {
    const simHandle: ChainHandle = {
      mode: "SIMULATED",
      config: {
        mode: "SIMULATED",
        endpoints: null,
        contractAddress: null,
        zkAssetsPath: "",
      },
      contractAddress: null,
      providers: null,
      zkAssetsPath: "",
    };
    await expect(
      readTransactionStatus(simHandle, "any-ref"),
    ).rejects.toThrowError(/Transaction status reads require a REAL handle/);
  });
});

describe("REAL/SIMULATED separation", () => {
  it("never treats a sim- prefixed chain reference as REAL confirmation", async () => {
    const app = createApp();
    const token = await sessionFor(app, "sim-sep");
    const agentId = await registerAgent(app, token, "sim-sep-a");
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "sim-sep-1" });
    const txId = created.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    // Operator can record any chain ref; the system must not treat sim-*
    // as authoritative finality.
    await request(app)
      .post(`/api/v1/transactions/${txId}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "sim-fake-finality" });

    const row: { rows: { status: string; confirmed_at: string | null }[] } =
      await query(
        "SELECT status, confirmed_at FROM chain_transactions WHERE id = $1",
        [txId],
      );
    expect(row.rows[0]?.status).toBe("SUBMITTED");
    expect(row.rows[0]?.confirmed_at).toBeNull();
  });
});
