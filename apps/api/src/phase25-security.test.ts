/**
 * Phase 25 wallet-relayed submission security tests (offline).
 *
 * Covers the fail-closed seams around REAL recording without any
 * network, wallet, or chain contact: malformed chain references,
 * duplicate and conflicting submissions, cross-operator and
 * unauthenticated recording, REAL confirmation without a chain
 * reference (no I/O performed), and secret hygiene across the
 * transaction and event surfaces.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { connectReadOnly } from "@bond/midnight-adapter";
import type { MidnightConfig } from "@bond/midnight-adapter";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { confirmTransactionService } from "./services/transactions.js";

const DEV_KEY = "test-dev-key";

// Offline REAL-mode handle: provider objects are constructed but
// never queried here — every test below throws before network I/O.
function offlineRealHandle(): Parameters<typeof confirmTransactionService>[1] {
  const config: MidnightConfig = {
    mode: "REAL",
    endpoints: {
      networkId: "undeployed",
      indexerHttp: "http://127.0.0.1:9/api/v4/graphql",
      indexerWs: "ws://127.0.0.1:9/api/v4/graphql/ws",
      nodeUrl: "http://127.0.0.1:9",
      proofServerUrl: "http://127.0.0.1:9",
    },
    contractAddress: "contract-undeployed-test",
    zkAssetsPath: "",
  };
  return connectReadOnly(config);
}

async function sessionFor(
  app: ReturnType<typeof createApp>,
  externalKey: string,
) {
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey });
  expect(sess.status).toBe(201);
  return sess.body.data.token as string;
}

async function registerAgent(
  app: ReturnType<typeof createApp>,
  token: string,
  externalRef: string,
) {
  const res = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef,
    });
  expect(res.status).toBe(201);
  return res.body.data.agentId as string;
}

async function pendingTx(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
  key: string,
) {
  const created = await request(app)
    .post("/api/v1/transactions")
    .set("Authorization", `Bearer ${token}`)
    .send({ purpose: "FUND_BOND", agentId, idempotencyKey: key });
  expect(created.status).toBe(201);
  const id = created.body.data.transactionId as string;
  for (const status of ["WALLET_APPROVAL", "PENDING"]) {
    const adv = await request(app)
      .post(`/api/v1/transactions/${id}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status });
    expect(adv.status).toBe(200);
  }
  return id;
}

beforeAll(async () => {
  await useIsolatedDb("phase25security");
});

describe("wallet-relayed submission guards", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects malformed chain references without state change", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-wr-malformed");
    const agentId = await registerAgent(app, token, "ext-wr-malformed");
    const id = await pendingTx(app, token, agentId, "wr-key-malformed");
    for (const chainTxId of ["", 12345, "x".repeat(257), null]) {
      const res = await request(app)
        .post(`/api/v1/transactions/${id}/submitted`)
        .set("Authorization", `Bearer ${token}`)
        .send({ chainTxId });
      expect(res.status, JSON.stringify(chainTxId)).toBe(400);
    }
    const row: { rows: { status: string; chain_tx_id: string | null }[] } =
      await query(
        "SELECT status, chain_tx_id FROM chain_transactions WHERE id = $1",
        [id],
      );
    expect(row.rows[0]).toMatchObject({
      status: "PENDING",
      chain_tx_id: null,
    });
  });

  it("duplicate recording of the same reference fails closed, once", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-wr-dupe");
    const agentId = await registerAgent(app, token, "ext-wr-dupe");
    const id = await pendingTx(app, token, agentId, "wr-key-dupe");
    const first = await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-1" });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("SUBMITTED");
    const replay = await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-1" });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("INVALID_TRANSACTION_TRANSITION");
    const events: { rows: { n: string }[] } = await query(
      `SELECT COUNT(*) AS n FROM protocol_events
       WHERE tx_id = $1 AND type = 'TRANSACTION_STATUS_CHANGED'
         AND payload->>'to' = 'SUBMITTED'`,
      [id],
    );
    expect(events.rows[0]?.n).toBe("1");
  });

  it("conflicting chain references fail with conflict, original kept", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-wr-conflict");
    const agentId = await registerAgent(app, token, "ext-wr-conflict");
    const id = await pendingTx(app, token, agentId, "wr-key-conflict");
    const first = await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-a" });
    expect(first.status).toBe(200);
    const fork = await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-b" });
    expect(fork.status).toBe(409);
    expect(fork.body.code).toBe("IDEMPOTENCY_CONFLICT");
    const row: { rows: { chain_tx_id: string }[] } = await query(
      "SELECT chain_tx_id FROM chain_transactions WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.chain_tx_id).toBe("chain-ref-a");
  });

  it("rejects unauthenticated and cross-operator recording", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-wr-alice");
    const bob = await sessionFor(app, "op-wr-bob");
    const agentId = await registerAgent(app, alice, "ext-wr-owned");
    const id = await pendingTx(app, alice, agentId, "wr-key-owned");
    const anon = await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .send({ chainTxId: "chain-ref-x" });
    expect(anon.status).toBe(401);
    const foreign = await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .set("Authorization", `Bearer ${bob}`)
      .send({ chainTxId: "chain-ref-x" });
    expect(foreign.status).toBe(403);
    const missing = await request(app)
      .post("/api/v1/transactions/tx_does_not_exist/submitted")
      .set("Authorization", `Bearer ${alice}`)
      .send({ chainTxId: "chain-ref-x" });
    expect(missing.status).toBe(404);
  });

  it("REAL confirmation without a chain reference fails before any I/O", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-wr-noref");
    const agentId = await registerAgent(app, token, "ext-wr-noref");
    const id = await pendingTx(app, token, agentId, "wr-key-noref");
    // Force SUBMITTED with no chain reference: the service must
    // reject before touching the (unreachable-by-design) network.
    await query(
      "UPDATE chain_transactions SET status = 'SUBMITTED', chain_tx_id = NULL WHERE id = $1",
      [id],
    );
    await expect(
      confirmTransactionService(id, offlineRealHandle(), "test", null),
    ).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
  });

  it("transaction and event surfaces carry no signing material", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-wr-hygiene");
    const agentId = await registerAgent(app, token, "ext-wr-hygiene");
    const id = await pendingTx(app, token, agentId, "wr-key-hygiene");
    await request(app)
      .post(`/api/v1/transactions/${id}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-hygiene" });
    const txs: { rows: Record<string, unknown>[] } = await query(
      "SELECT * FROM chain_transactions WHERE id = $1",
      [id],
    );
    const events: { rows: { payload: unknown }[] } = await query(
      "SELECT payload FROM protocol_events WHERE tx_id = $1",
      [id],
    );
    const serialized = JSON.stringify([txs.rows, events.rows]).toLowerCase();
    for (const banned of [
      "privatekey",
      "private_key",
      "signing secret",
      "mnemonic",
      "seed phrase",
      "witness",
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });
});
