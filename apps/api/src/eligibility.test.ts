import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";

beforeAll(async () => {
  await useIsolatedDb("eligibility");
});

const DEV_KEY = "test-dev-key";

async function setup() {
  const app = createApp();
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "grace" });
  const token = sess.body.token as string;
  const agent = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "elig-agent-1",
    });
  const agentId = agent.body.data.agentId as string;
  const bond = await request(app)
    .post("/api/v1/bonds")
    .set("Authorization", `Bearer ${token}`)
    .send({ agentId, commitmentMinorUnits: "10000" });
  return { app, token, agentId, bondId: bond.body.data.bondId as string };
}

describe("eligibility API", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates, verifies, and consumes a proof without leaking witnesses", async () => {
    const { app, token, agentId, bondId } = await setup();
    const created = await request(app)
      .post("/api/v1/eligibility/proofs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        bondId,
        requiredMinimumMinorUnits: "1000",
        nonce: "nonce-elig-1",
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    expect(created.status).toBe(201);
    const proofId = created.body.data.proofId as string;
    expect(JSON.stringify(created.body)).not.toContain("10000");

    const verified = await request(app)
      .get(`/api/v1/eligibility/proofs/${proofId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(verified.status).toBe(200);
    expect(verified.body.data.eligible).toBe(true);

    const consumed = await request(app)
      .post(`/api/v1/eligibility/proofs/${proofId}/consume`)
      .set("Authorization", `Bearer ${token}`)
      .send({ nonce: "nonce-redeem-1" });
    expect(consumed.status).toBe(200);
    const again = await request(app)
      .post(`/api/v1/eligibility/proofs/${proofId}/consume`)
      .set("Authorization", `Bearer ${token}`)
      .send({ nonce: "nonce-redeem-2" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("REPLAYED_ELIGIBILITY_PROOF");
  });

  it("rejects missing thresholds and unknown proofs", async () => {
    const { app, token } = await setup();
    const bad = await request(app)
      .post("/api/v1/eligibility/proofs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId: "x",
        bondId: "y",
        nonce: "n",
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .get("/api/v1/eligibility/proofs/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });
});
