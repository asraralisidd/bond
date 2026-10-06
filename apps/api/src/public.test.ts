import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";

beforeAll(async () => {
  await useIsolatedDb("public");
});

const DEV_KEY = "test-dev-key";

async function setup() {
  const app = createApp();
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "heidi" });
  const token = sess.body.token as string;
  const agent = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "public-agent-1",
    });
  return { app, token, agentId: agent.body.data.agentId as string };
}

describe("public verification + privacy", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("answers verification without credentials and without private data", async () => {
    const { app, token, agentId } = await setup();
    await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "424242" });
    const res = await request(app).get(`/api/v1/public/agents/${agentId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.agentId).toBe(agentId);
    expect(["trusted", "caution", "untrusted"]).toContain(
      res.body.data.verification.result,
    );
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("424242");
    expect(serialized).not.toContain("commitment");
    expect(serialized).not.toContain("operator");
  });

  it("returns 404-shaped responses for unknown agents", async () => {
    const { app } = await setup();
    const res = await request(app).get(
      "/api/v1/public/agents/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("exposes eligibility statements publicly without witnesses", async () => {
    const { app, token, agentId } = await setup();
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "9000" });
    await request(app)
      .post("/api/v1/eligibility/proofs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        bondId: bond.body.data.bondId,
        requiredMinimumMinorUnits: "100",
        nonce: "nonce-pub-1",
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    const res = await request(app).get(
      `/api/v1/public/agents/${agentId}/eligibility`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe(agentId);
    expect(res.body.data.proofs).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("9000");
  });

  it("never leaks stack traces, SQL, or secrets in errors", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/api/v1/agents")
      .send({ platform: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: "UNAUTHORIZED",
      message: expect.any(String),
      requestId: expect.anything(),
    });
    expect(JSON.stringify(res.body)).not.toContain("Error");
    expect(JSON.stringify(res.body)).not.toContain("at ");
  });
});
