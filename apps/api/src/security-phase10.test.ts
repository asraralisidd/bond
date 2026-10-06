/**
 * Phase 10 adversarial security tests.
 *
 * Covers the gaps found in the production-security audit that are not
 * already covered by earlier suites:
 *
 * A. Cross-operator transaction creation (BOLA fix)
 * B. Attestor registration create-only (credential-takeover fix)
 * C. Pagination limit validation
 * D. Capabilities element validation
 * E. Idempotency-key shape + same-key/different-payload conflicts
 * F. Strict identifier parsing (400, not 404/500)
 * G. SQL-shaped input is inert and leak-free
 * H. Public verification privacy
 * I. Sign-out revokes only the caller's session
 * J. Error envelope never leaks internals
 *
 * Deterministic: no sleeps, isolated DB, fresh app per test.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";

const DEV_KEY = "test-dev-key";

type App = ReturnType<typeof createApp>;

async function sessionFor(app: App, externalKey: string): Promise<string> {
  process.env.DEV_AUTH_TOKEN = DEV_KEY;
  const sess = await request(app)
    .post("/api/v1/auth/session")
    .send({ devKey: DEV_KEY, externalKey });
  expect(sess.status).toBe(201);
  return sess.body.token as string;
}

async function registerAgent(
  app: App,
  token: string,
  externalRef: string,
): Promise<string> {
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

async function createBond(
  app: App,
  token: string,
  agentId: string,
): Promise<string> {
  const res = await request(app)
    .post("/api/v1/bonds")
    .set("Authorization", `Bearer ${token}`)
    .send({ agentId, commitmentMinorUnits: "10000" });
  expect(res.status).toBe(201);
  return res.body.data.bondId as string;
}

async function analyze(
  app: App,
  token: string,
  agentId: string,
): Promise<string> {
  const res = await request(app)
    .post("/api/v1/risk/analyses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      agentId,
      activity: {
        activityId: "act-sec",
        occurredAt: "2026-01-01T00:00:00.000Z",
        actionType: "transfer",
        action: "pay-vendor",
        amountMinorUnits: "5000",
        policyContext: {
          policyVersion: "bond-policy-v1",
          allowedActions: ["pay-vendor"],
          spendLimitMinorUnits: "1000",
        },
      },
    });
  expect(res.status).toBe(201);
  return res.body.data.flagIds[0] as string;
}

beforeAll(async () => {
  await useIsolatedDb("security10");
});

beforeEach(async () => {
  await resetDb();
});

describe("A. cross-operator transaction creation", () => {
  it("rejects intents referencing another operator's agent", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice-sec-a");
    const bob = await sessionFor(app, "bob-sec-a");
    const agentId = await registerAgent(app, alice, "sec-a-1");

    const cross = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${bob}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        idempotencyKey: "sec-cross-1",
      });
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe("FORBIDDEN");

    // Control: own agent works.
    const ownAgent = await registerAgent(app, bob, "sec-a-2");
    const own = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${bob}`)
      .send({
        purpose: "FUND_BOND",
        agentId: ownAgent,
        idempotencyKey: "sec-own-1",
      });
    expect(own.status).toBe(201);
  });

  it("rejects intents referencing another operator's bond", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice-sec-b");
    const bob = await sessionFor(app, "bob-sec-b");
    const agentId = await registerAgent(app, alice, "sec-b-1");
    const bondId = await createBond(app, alice, agentId);

    const cross = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${bob}`)
      .send({
        purpose: "RELEASE_BOND",
        bondId,
        idempotencyKey: "sec-cross-2",
      });
    expect(cross.status).toBe(403);
  });

  it("returns 404 for unknown agent/bond references", async () => {
    const app = createApp();
    const bob = await sessionFor(app, "bob-sec-c");
    const badAgent = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${bob}`)
      .send({
        purpose: "FUND_BOND",
        agentId: "00000000-0000-0000-0000-000000000000",
        idempotencyKey: "sec-unknown-1",
      });
    expect(badAgent.status).toBe(404);
    const badBond = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${bob}`)
      .send({
        purpose: "RELEASE_BOND",
        bondId: "00000000-0000-0000-0000-000000000000",
        idempotencyKey: "sec-unknown-2",
      });
    expect(badBond.status).toBe(404);
  });

  it("rejects advance/confirm/read of another operator's transaction", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice-sec-d");
    const bob = await sessionFor(app, "bob-sec-d");
    const agentId = await registerAgent(app, alice, "sec-d-1");
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        idempotencyKey: "sec-alice-tx-1",
      });
    expect(created.status).toBe(201);
    const txId = created.body.data.transactionId as string;

    const read = await request(app)
      .get(`/api/v1/transactions/${txId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(read.status).toBe(403);
    const advance = await request(app)
      .post(`/api/v1/transactions/${txId}/advance`)
      .set("Authorization", `Bearer ${bob}`)
      .send({ status: "WALLET_APPROVAL" });
    expect(advance.status).toBe(403);
  });
});

describe("B. attestor registration is create-only", () => {
  it("rejects re-registration and preserves the original secret", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice-sec-e");
    const bob = await sessionFor(app, "bob-sec-e");
    const agentId = await registerAgent(app, alice, "sec-e-1");
    const flagId = await analyze(app, alice, agentId);

    const first = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        attestorId: "sec-att-1",
        organization: "Org A",
        secret: "original-secret-0001",
      });
    expect(first.status).toBe(201);

    // Another operator cannot squat or rotate the credential.
    const squat = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${bob}`)
      .send({
        attestorId: "sec-att-1",
        organization: "Org Evil",
        secret: "attacker-secret-0002",
      });
    expect(squat.status).toBe(400);

    // The attestation flow still honors the ORIGINAL secret only.
    const requested = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        flagId,
        attestorIds: ["sec-att-1"],
        threshold: 1,
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
    expect(requested.status).toBe(201);
    const attestationId = requested.body.data.attestationId as string;

    const forged = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", "attacker-secret-0002")
      .send({ attestorId: "sec-att-1", verdict: "confirm" });
    expect(forged.status).toBe(401);

    const genuine = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", "original-secret-0001")
      .send({ attestorId: "sec-att-1", verdict: "confirm" });
    expect(genuine.status).toBe(201);
  });

  it("rejects malformed caller-supplied attestor ids", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice-sec-f");
    const bad = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        attestorId: "x".repeat(200),
        organization: "Org",
        secret: "0123456789abcdef",
      });
    expect(bad.status).toBe(400);
  });
});

describe("C. pagination limit validation", () => {
  it.each(["abc", "-5", "0", "1.5", "101", "NaN"])(
    "rejects limit=%s with 400",
    async (limit) => {
      const app = createApp();
      const token = await sessionFor(app, `op-sec-g-${limit}`);
      const res = await request(app)
        .get(`/api/v1/agents?limit=${limit}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IDENTIFIER");
    },
  );

  it("accepts a valid limit", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-g-ok");
    const res = await request(app)
      .get("/api/v1/agents?limit=5")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("D. capabilities validation", () => {
  it("rejects non-string, empty, oversized, and excessive capabilities", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-h");
    const cases: unknown[][] = [
      [42],
      [""],
      ["   "],
      ["x".repeat(257)],
      new Array(101).fill("ok"),
    ];
    for (const capabilities of cases) {
      const res = await request(app)
        .post("/api/v1/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({
          platform: "custom",
          agentType: "custom",
          capabilities,
          externalRef: `sec-h-${String(capabilities.length)}`,
        });
      expect(res.status).toBe(400);
    }
  });
});

describe("E. idempotency-key shape and conflicts", () => {
  it("rejects oversized keys with 400", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-i");
    const agentId = await registerAgent(app, token, "sec-i-1");
    const res = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        idempotencyKey: "k".repeat(257),
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDENTIFIER");
  });

  it("replays same payload but conflicts on different payload", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-j");
    const agentId = await registerAgent(app, token, "sec-j-1");
    const first = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        idempotencyKey: "sec-replay-1",
      });
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        idempotencyKey: "sec-replay-1",
      });
    expect(replay.status).toBe(200);
    const conflict = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "WITHDRAW",
        agentId,
        idempotencyKey: "sec-replay-1",
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("F. strict identifier parsing", () => {
  it("returns 400 for oversized resource ids", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-k");
    const long = "x".repeat(200);
    const bond = await request(app)
      .get(`/api/v1/bonds/${long}`)
      .set("Authorization", `Bearer ${token}`);
    expect(bond.status).toBe(400);
    const tx = await request(app)
      .get(`/api/v1/transactions/${long}`)
      .set("Authorization", `Bearer ${token}`);
    expect(tx.status).toBe(400);
    const flag = await request(app)
      .get(`/api/v1/risk/flags/${long}`)
      .set("Authorization", `Bearer ${token}`);
    expect(flag.status).toBe(400);
  });
});

describe("G. SQL-shaped input is inert", () => {
  it("treats injection-shaped ids as plain misses", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-l");
    const res = await request(app)
      .get(`/api/v1/agents/'%20OR%20'1'%3D'1`)
      .set("Authorization", `Bearer ${token}`);
    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|syntax|pg_|relation/i);
  });

  it("stores SQL-shaped text literally without executing it", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-sec-m");
    const payload = "'; DROP TABLE agents;--";
    const created = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: payload,
        agentType: "custom",
        capabilities: [],
        externalRef: "sec-m-1",
      });
    expect(created.status).toBe(201);
    // The table still works: registry is intact.
    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { platform: string }[]).some(
        (a) => a.platform === payload,
      ),
    ).toBe(true);
  });
});

describe("H. public verification privacy", () => {
  it("exposes no private amounts, witnesses, nullifiers, or operators", async () => {
    const app = createApp();
    const token = await sessionFor(app, "alice-sec-n");
    const agentId = await registerAgent(app, token, "sec-n-1");
    await createBond(app, token, agentId);
    await analyze(app, token, agentId);
    const res = await request(app).get(`/api/v1/public/agents/${agentId}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const secret of [
      "commitmentMinorUnits",
      "witness",
      "nullifier",
      "secret",
      "10000",
      "alice-sec-n",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("I. sign-out is session-scoped", () => {
  it("revokes only the caller's session", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice-sec-o");
    const bob = await sessionFor(app, "bob-sec-o");
    const out = await request(app)
      .post("/api/v1/auth/sign-out")
      .set("Authorization", `Bearer ${alice}`);
    expect(out.status).toBe(200);
    const aliceAfter = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${alice}`);
    expect(aliceAfter.status).toBe(401);
    const bobAfter = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${bob}`);
    expect(bobAfter.status).toBe(200);
  });
});

describe("J. error envelope never leaks internals", () => {
  it("unknown routes return the safe envelope only", async () => {
    const app = createApp();
    const res = await request(app).get("/api/v1/nope-not-here");
    expect(res.status).toBe(404);
    expect(Object.keys(res.body).sort()).toEqual(
      ["code", "message", "requestId"].sort(),
    );
    expect(res.body.requestId).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(
      /stack|Error:|at\s+\/|SELECT|FROM|DATABASE_URL|secret|node_modules/i,
    );
  });
});
