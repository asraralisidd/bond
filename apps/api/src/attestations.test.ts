import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { runTransactionWorkerOnce } from "./services/transactions.js";

beforeAll(async () => {
  await useIsolatedDb("attestations");
});

const DEV_KEY = "test-dev-key";
const ATTESTOR_SECRET = "attestor-secret-0123456789";

async function setup() {
  const app = createApp();
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "frank" });
  const token = sess.body.data.token as string;
  const agent = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "att-agent-1",
    });
  const agentId = agent.body.data.agentId as string;
  const analyzed = await request(app)
    .post("/api/v1/risk/analyses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      agentId,
      activity: {
        activityId: "act-flag-1",
        occurredAt: "2026-10-06T10:00:00.000Z",
        actionType: "transfer",
        action: "pay-vendor",
        amountMinorUnits: "9000",
        policyContext: {
          policyVersion: "bond-policy-v1",
          allowedActions: ["pay-vendor"],
          spendLimitMinorUnits: "100",
        },
      },
    });
  const attestor = await request(app)
    .post("/api/v1/attestors")
    .set("Authorization", `Bearer ${token}`)
    .send({ organization: "Org A", secret: ATTESTOR_SECRET });
  return {
    app,
    token,
    agentId,
    flagId: analyzed.body.data.flagIds[0] as string,
    attestorId: attestor.body.data.attestorId as string,
  };
}

describe("attestations API", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("requests, evaluates, and reads an attestation", async () => {
    const { app, token, flagId, attestorId } = await setup();
    const requested = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        flagId,
        attestorIds: [attestorId],
        threshold: 1,
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    expect(requested.status).toBe(201);
    const attestationId = requested.body.data.attestationId as string;

    const verdict = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", ATTESTOR_SECRET)
      .send({ attestorId, verdict: "confirm" });
    expect(verdict.status).toBe(201);
    expect(verdict.body.data.status).toBe("quorum-met");

    const read = await request(app)
      .get(`/api/v1/attestations/${attestationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body.data.status).toBe("quorum-met");

    const badSecret = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", "wrong-secret-value-here")
      .send({ attestorId, verdict: "confirm" });
    expect(badSecret.status).toBe(401);
  });

  it("auto-evaluates, decides, and enforces through a transaction intent", async () => {
    const { app, token, agentId, flagId } = await setup();
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "10000" });
    const bondId = bond.body.data.bondId as string;
    // Fund first so enforcement has a slashable target.
    const fund = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        bondId,
        idempotencyKey: "fund-9",
      });
    const fundId = fund.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${fundId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    const handle = connectMidnight(resolveMidnightConfig({}));
    await runTransactionWorkerOnce(handle);
    await request(app)
      .post(`/api/v1/transactions/${fundId}/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    const requested = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        flagId,
        attestorIds: ["attestor-x"],
        threshold: 1,
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    const attestationId = requested.body.data.attestationId as string;
    const evaluated = await request(app)
      .post(`/api/v1/attestations/${attestationId}/evaluate`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(evaluated.status).toBe(200);
    const decided = await request(app)
      .post(`/api/v1/attestations/${attestationId}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(decided.status).toBe(201);
    expect(decided.body.data.status).toBe("decided");

    const enforce = await request(app)
      .post(`/api/v1/attestations/${attestationId}/enforce`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountMinorUnits: "1000", idempotencyKey: "enforce-9" });
    expect(enforce.status).toBe(201);
    const txId = enforce.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    await runTransactionWorkerOnce(handle);
    const tx = await request(app)
      .get(`/api/v1/transactions/${txId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(tx.body.data.status).toBe("SUBMITTED");
    expect(tx.body.data.chainTxId?.startsWith("sim-")).toBe(true);
    await request(app)
      .post(`/api/v1/transactions/${txId}/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    const bondAfter = await request(app)
      .get(`/api/v1/bonds/${bondId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(bondAfter.body.data.status).toBe("PARTIALLY_SLASHED");
    expect(bondAfter.body.data.slashedTotalMinorUnits).toBe("1000");
  });
});
