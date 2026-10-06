import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";

const DEV_KEY = "test-dev-key";

async function authedAgent(app: ReturnType<typeof createApp>) {
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey: "alice" });
  expect(sess.status).toBe(201);
  return sess.body.token as string;
}

beforeAll(async () => {
  await useIsolatedDb("agents");
});

describe("agents API", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects unauthenticated registration", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/agents").send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("registers, lists, and fetches an agent with request IDs", async () => {
    const app = createApp();
    const token = await authedAgent(app);
    const created = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "langchain",
        agentType: "workflow",
        capabilities: ["read"],
        externalRef: "ext-1",
      });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("REGISTERED");
    expect(created.headers["x-request-id"]).toBeTruthy();

    const listed = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);

    const fetched = await request(app)
      .get(`/api/v1/agents/${created.body.data.agentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.externalRef).toBe("ext-1");
  });

  it("rejects duplicate registration triples and cross-operator reads", async () => {
    const app = createApp();
    const token = await authedAgent(app);
    const body = {
      platform: "langchain",
      agentType: "workflow",
      capabilities: [],
      externalRef: "ext-dup",
    };
    const first = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(first.status).toBe(201);
    const dup = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(dup.status).toBe(400);

    process.env.DEV_AUTH_TOKEN = DEV_KEY;
    const bob = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: DEV_KEY, externalKey: "bob" });
    const cross = await request(app)
      .get(`/api/v1/agents/${first.body.data.agentId}`)
      .set("Authorization", `Bearer ${bob.body.token}`);
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe("FORBIDDEN");
  });

  it("rejects invalid status transitions", async () => {
    const app = createApp();
    const token = await authedAgent(app);
    const created = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "x",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-t",
      });
    const bad = await request(app)
      .patch(`/api/v1/agents/${created.body.data.agentId}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "ACTIVE" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_AGENT_TRANSITION");
  });
});
