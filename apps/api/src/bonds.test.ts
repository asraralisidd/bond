import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";

const DEV_KEY = "test-dev-key";

async function setup() {
  const app = createApp();
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "carol" });
  const token = sess.body.data.token as string;
  const agent = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "bond-agent-1",
    });
  return { app, token, agentId: agent.body.data.agentId as string };
}

beforeAll(async () => {
  await useIsolatedDb("bonds");
});

describe("bonds API + idempotency", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a bond and rejects invalid input", async () => {
    const { app, token, agentId } = await setup();
    const created = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "5000" });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("CREATED");

    const bad = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "0" });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId: "00000000-0000-0000-0000-000000000000",
        commitmentMinorUnits: "5",
      });
    expect(missing.status).toBe(404);
  });

  it("replays the same idempotency key and conflicts on reuse", async () => {
    const { app, token, agentId } = await setup();
    const body = { agentId, commitmentMinorUnits: "7000" };
    const first = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "key-abc-123")
      .send(body);
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "key-abc-123")
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.bondId).toBe(first.body.data.bondId);
    const conflict = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "key-abc-123")
      .send({ ...body, commitmentMinorUnits: "9000" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("handles concurrent duplicate bond creation safely", async () => {
    const { app, token, agentId } = await setup();
    const body = { agentId, commitmentMinorUnits: "3000" };
    const results = await Promise.all([
      request(app)
        .post("/api/v1/bonds")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "key-race-1")
        .send(body),
      request(app)
        .post("/api/v1/bonds")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "key-race-1")
        .send(body),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 201]);
    expect(results[0].body.data.bondId).toBe(results[1].body.data.bondId);
  });

  it("walks bond transitions and rejects invalid ones", async () => {
    const { app, token, agentId } = await setup();
    const created = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "1000" });
    const bondId = created.body.data.bondId as string;
    const toPending = await request(app)
      .patch(`/api/v1/bonds/${bondId}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "PENDING" });
    expect(toPending.status).toBe(200);
    expect(toPending.body.data.status).toBe("PENDING");
    const bad = await request(app)
      .patch(`/api/v1/bonds/${bondId}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "WITHDRAWABLE" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_BOND_TRANSITION");
  });
});
