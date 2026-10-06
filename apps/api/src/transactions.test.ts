import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { runTransactionWorkerOnce } from "./services/transactions.js";

const DEV_KEY = "test-dev-key";

async function setup() {
  const app = createApp();
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "dave" });
  return { app, token: sess.body.token as string };
}

beforeAll(async () => {
  await useIsolatedDb("transactions");
});

describe("transactions API + worker", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates intents idempotently and advances the lifecycle", async () => {
    const { app, token } = await setup();
    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "tx-owner-agent",
      });
    const agentId = agent.body.data.agentId as string;
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "tx-key-1" });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("IDLE");
    const replay = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "tx-key-1" });
    expect(replay.status).toBe(200);
    expect(replay.body.data.transactionId).toBe(
      created.body.data.transactionId,
    );
    const id = created.body.data.transactionId as string;
    const adv = await request(app)
      .post(`/api/v1/transactions/${id}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "WALLET_APPROVAL" });
    expect(adv.status).toBe(200);
    // Skipping PENDING is rejected by the Phase 1 machine.
    const bad = await request(app)
      .post(`/api/v1/transactions/${id}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "SUBMITTED" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_TRANSACTION_TRANSITION");
  });

  it("worker submits SIMULATED intents but never auto-confirms", async () => {
    const { app, token } = await setup();
    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "worker-agent",
      });
    const agentId = agent.body.data.agentId as string;
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "2000" });
    const bondId = bond.body.data.bondId as string;
    const tx = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        bondId,
        idempotencyKey: "tx-worker-1",
      });
    const txId = tx.body.data.transactionId as string;
    await request(app)
      .post(`/api/v1/transactions/${txId}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "WALLET_APPROVAL" });
    await request(app)
      .post(`/api/v1/transactions/${txId}/advance`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "PENDING" });
    const handle = connectMidnight(resolveMidnightConfig({}));
    const report = await runTransactionWorkerOnce(handle);
    expect(report.processed).toBe(1);
    expect(report.submitted).toBe(1);
    const after = await request(app)
      .get(`/api/v1/transactions/${txId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(after.body.data.status).toBe("SUBMITTED");
    expect(after.body.data.chainTxId?.startsWith("sim-")).toBe(true);
    // Explicit operator confirm only (dev): never automatic.
    const confirmed = await request(app)
      .post(`/api/v1/transactions/${txId}/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(confirmed.body.data.status).toBe("CONFIRMED");
    const bondAfter = await request(app)
      .get(`/api/v1/bonds/${bondId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(bondAfter.body.data.status).toBe("ACTIVE");
  });
});
