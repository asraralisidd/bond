import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";

beforeAll(async () => {
  await useIsolatedDb("risk");
});

const DEV_KEY = "test-dev-key";

async function setup() {
  const app = createApp();
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "erin" });
  const token = sess.body.token as string;
  const agent = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "risk-agent-1",
    });
  return { app, token, agentId: agent.body.data.agentId as string };
}

const ACTIVITY = {
  activityId: "act-1",
  occurredAt: "2026-10-06T10:00:00.000Z",
  actionType: "transfer",
  action: "pay-vendor",
  amountMinorUnits: "5000",
  policyContext: {
    policyVersion: "bond-policy-v1",
    allowedActions: ["pay-vendor"],
    spendLimitMinorUnits: "1000",
  },
};

describe("risk API", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("analyzes activity, persists flags, and lists them without raw content", async () => {
    const { app, token, agentId } = await setup();
    const analyzed = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: ACTIVITY });
    expect(analyzed.status).toBe(201);
    expect(analyzed.body.data.flagIds.length).toBeGreaterThan(0);
    expect(analyzed.body.data.score).toBeTruthy();

    const flags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(flags.status).toBe(200);
    expect(flags.body.data.length).toBe(analyzed.body.data.flagIds.length);
    const serialized = JSON.stringify(flags.body);
    expect(serialized).not.toContain("transcript");
    const detail = await request(app)
      .get(`/api/v1/risk/flags/${analyzed.body.data.flagIds[0]}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.evidenceIds.length).toBeGreaterThan(0);
  });

  it("rejects invalid activity with domain codes", async () => {
    const { app, token, agentId } = await setup();
    const bad = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: { ...ACTIVITY, actionType: "teleport" } });
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId: "00000000-0000-0000-0000-000000000000",
        activity: ACTIVITY,
      });
    expect(missing.status).toBe(404);
  });
});
