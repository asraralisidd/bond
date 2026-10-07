/**
 * Phase 19.1 event feed tests: scope enforcement, capability gating,
 * cursor pagination determinism, input validation, rate limiting,
 * privacy, and regression coverage.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";

const DEV_KEY = "test-dev-key";

interface CreatedCredential {
  metadata: { credentialId: string };
  secret: string;
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
      platform: "p",
      agentType: "custom",
      capabilities: [],
      externalRef,
    });
  expect(res.status).toBe(201);
  return res.body.data.agentId as string;
}

async function createCredential(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
  body: Record<string, unknown> = {},
): Promise<CreatedCredential> {
  const res = await request(app)
    .post(`/api/v1/agents/${agentId}/credentials`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body.data as CreatedCredential;
}

function agentBearer(created: CreatedCredential): string {
  return `${created.metadata.credentialId}.${created.secret}`;
}

let activitySeq = 0;

async function submitActivity(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
  action = "pay-vendor",
) {
  activitySeq += 1;
  const res = await request(app)
    .post("/api/v1/risk/analyses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      agentId,
      activity: {
        activityId: `act-ev-${activitySeq}`,
        actionType: "transfer",
        action,
        occurredAt: new Date().toISOString(),
        policyContext: {
          policyVersion: "bond-policy-v1",
          allowedActions: ["pay-vendor"],
        },
      },
    });
  expect(res.status).toBe(201);
  return res.body.data as { analysisId: string; flagIds: string[] };
}

beforeAll(async () => {
  await useIsolatedDb("events");
});

beforeEach(async () => {
  await resetDb();
});

describe("A. operator scope", () => {
  it("1. operator retrieves own visible events", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-1");
    const agentId = await registerAgent(app, token, "ext-ev-1");
    await submitActivity(app, token, agentId);
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.events)).toBe(true);
    expect(res.body.data.events.length).toBeGreaterThan(0);
    for (const event of res.body.data.events) {
      expect(event).toHaveProperty("id");
      expect(event).toHaveProperty("type");
      expect(event).toHaveProperty("createdAt");
    }
  });

  it("2. operator cannot retrieve another operator's events", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-ev-alice");
    const bob = await sessionFor(app, "op-ev-bob");
    const agentA = await registerAgent(app, alice, "ext-ev-a");
    await submitActivity(app, alice, agentA);
    const bobFeed = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${bob}`);
    expect(bobFeed.status).toBe(200);
    expect(bobFeed.body.data.events).toEqual([]);
    expect(bobFeed.body.data.nextCursor).toBeNull();
  });

  it("6. operator sessions remain compatible (no capability checks)", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-compat");
    const agentId = await registerAgent(app, token, "ext-ev-compat");
    await submitActivity(app, token, agentId);
    const filtered = await request(app)
      .get("/api/v1/events?type=RISK_FLAG_RAISED")
      .set("Authorization", `Bearer ${token}`);
    expect(filtered.status).toBe(200);
    const none = await request(app)
      .get("/api/v1/events?type=NO_SUCH_TYPE_XYZ")
      .set("Authorization", `Bearer ${token}`);
    expect(none.status).toBe(200);
    expect(none.body.data.events).toEqual([]);
  });
});

describe("B. agent scope", () => {
  it("3. agent retrieves own events", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-agent");
    const agentId = await registerAgent(app, token, "ext-ev-agent");
    await submitActivity(app, token, agentId);
    const created = await createCredential(app, token, agentId);
    const feed = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${agentBearer(created)}`);
    expect(feed.status).toBe(200);
    expect(feed.body.data.events.length).toBeGreaterThan(0);
    for (const event of feed.body.data.events) {
      expect(event.agentId).toBe(agentId);
    }
  });

  it("4. agent cannot retrieve another agent's events", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-sib");
    const agentA = await registerAgent(app, token, "ext-ev-sib-a");
    const agentB = await registerAgent(app, token, "ext-ev-sib-b");
    await submitActivity(app, token, agentB);
    const credA = await createCredential(app, token, agentA);
    const feedA = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${agentBearer(credA)}`);
    expect(feedA.status).toBe(200);
    for (const event of feedA.body.data.events) {
      expect(event.agentId).toBe(agentA);
    }
    expect(
      feedA.body.data.events.some(
        (e: { agentId: string }) => e.agentId === agentB,
      ),
    ).toBe(false);
  });

  it("5. agent credential without the capability is denied", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-nocap");
    const agentId = await registerAgent(app, token, "ext-ev-nocap");
    const created = await createCredential(app, token, agentId, {
      capabilities: ["agent:read"],
    });
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${agentBearer(created)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });
});

describe("C. authentication and validation", () => {
  it("7. unauthenticated caller is rejected", async () => {
    const app = createApp();
    const missing = await request(app).get("/api/v1/events");
    expect(missing.status).toBe(401);
    const malformed = await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Token abc");
    expect(malformed.status).toBe(401);
    const bogus = await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Bearer not-a-real-token");
    expect(bogus.status).toBe(401);
  });

  it("8. malformed cursor rejected safely", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-cursor");
    for (const cursor of [
      "!!!not-base64!!!",
      "bm90LWpzb24=",
      "e30=",
      Buffer.from(JSON.stringify({ t: 123, id: "x" }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ t: "12:00", id: "x" }), "utf8").toString(
        "base64url",
      ),
      "x".repeat(600),
    ]) {
      const res = await request(app)
        .get(`/api/v1/events?cursor=${encodeURIComponent(cursor)}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IDENTIFIER");
    }
  });

  it("12/13/14. limit default works, maximum enforced, invalid rejected", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-limit");
    const agentId = await registerAgent(app, token, "ext-ev-limit");
    await submitActivity(app, token, agentId);
    const def = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`);
    expect(def.status).toBe(200);
    expect(def.body.data.events.length).toBeLessThanOrEqual(50);
    for (const bad of ["0", "-5", "1.5", "abc", "101", "1000000"]) {
      const res = await request(app)
        .get(`/api/v1/events?limit=${bad}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
    }
    const max = await request(app)
      .get("/api/v1/events?limit=100")
      .set("Authorization", `Bearer ${token}`);
    expect(max.status).toBe(200);
  });

  it("19. empty feed behaves correctly", async () => {
    const app = createApp();
    // An operator with no agents has a genuinely empty feed; a fresh
    // registration always emits AGENT_REGISTERED (tested elsewhere).
    const token = await sessionFor(app, "op-ev-empty");
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.nextCursor).toBeNull();
  });
});

describe("D. pagination determinism", () => {
  it("9/10/11. pages are deterministic, disjoint, and lossless", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-pages");
    const agentId = await registerAgent(app, token, "ext-ev-pages");
    // Registration (1 event) + 3 analyses with unlisted actions (each
    // yields at least one flag event deterministically).
    await submitActivity(app, token, agentId, "rogue-action-1");
    await submitActivity(app, token, agentId, "rogue-action-2");
    await submitActivity(app, token, agentId, "rogue-action-3");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs =
        cursor === null
          ? "/api/v1/events?limit=2"
          : `/api/v1/events?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res: request.Response = await request(app)
        .get(qs)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.events.length).toBeLessThanOrEqual(2);
      for (const event of res.body.data.events) {
        seen.push(`${event.createdAt}|${event.id}`);
      }
      cursor = res.body.data.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(30);
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(1);
    // No duplicates.
    expect(new Set(seen).size).toBe(seen.length);
    // Lossless: every event id from a full read appears exactly once.
    const full = await request(app)
      .get("/api/v1/events?limit=100")
      .set("Authorization", `Bearer ${token}`);
    const fullIds = (full.body.data.events as { id: string }[]).map(
      (e) => e.id,
    );
    expect(seen.map((s) => s.split("|")[1]).sort()).toEqual(
      [...fullIds].sort(),
    );
  });

  it("repeated reads of the same page are stable", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-stable");
    const agentId = await registerAgent(app, token, "ext-ev-stable");
    await submitActivity(app, token, agentId);
    const first = await request(app)
      .get("/api/v1/events?limit=2")
      .set("Authorization", `Bearer ${token}`);
    const second = await request(app)
      .get("/api/v1/events?limit=2")
      .set("Authorization", `Bearer ${token}`);
    expect(second.body).toEqual(first.body);
  });
});

describe("E. privacy and envelope", () => {
  it("16/17. no secrets, no DB internals in output", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-priv");
    const agentId = await registerAgent(app, token, "ext-ev-priv");
    await submitActivity(app, token, agentId);
    const res = await request(app)
      .get("/api/v1/events?limit=100")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body.data);
    expect(res.body.data).toHaveProperty("events");
    expect(res.body.data).toHaveProperty("nextCursor");
    for (const key of [
      "secret",
      "secret_hash",
      "token_hash",
      "password",
      "witness",
      "private_key",
      "mnemonic",
      "Authorization",
    ]) {
      expect(text).not.toContain(key);
    }
    for (const event of res.body.data.events) {
      expect(Object.keys(event).sort()).toEqual(
        [
          "actor",
          "agentId",
          "bondId",
          "createdAt",
          "id",
          "payload",
          "policyVersion",
          "requestId",
          "txId",
          "type",
        ].sort(),
      );
    }
  });

  it("18. request-id behavior intact", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-rid");
    const withId = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", "req-ev-1");
    expect(withId.status).toBe(200);
    expect(withId.headers["x-request-id"]).toBe("req-ev-1");
    const generated = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`);
    expect(generated.headers["x-request-id"]).toBeTruthy();
  });
});

describe("F. rate limiting and regression", () => {
  it("15. rate limiting applies without breaking the feed", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-rl");
    const agentId = await registerAgent(app, token, "ext-ev-rl");
    const ok = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["x-ratelimit-limit"]).toBeTruthy();
    expect(agentId).toBeTruthy();
  });

  it("20. existing protocol event creation unchanged", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-reg");
    const agentId = await registerAgent(app, token, "ext-ev-reg");
    await submitActivity(app, token, agentId, "rogue-reg-action");
    const rows: { rows: { type: string }[] } = await query(
      "SELECT type FROM protocol_events WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId],
    );
    const types = rows.rows.map((r) => r.type);
    expect(types).toContain("AGENT_REGISTERED");
    expect(types).toContain("RISK_FLAG_RAISED");
  });
});
