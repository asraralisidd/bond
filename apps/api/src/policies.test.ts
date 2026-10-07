/**
 * Phase 22 policy & capability integration tests.
 *
 * Covers: policy CRUD + history, validation, version-conflict and
 * concurrency semantics, idempotent creation, operator/agent
 * authorization and isolation, effective-policy enforcement over
 * caller context (server authority), v3 findings/scoring/version
 * stamps, usage-window evaluation, response policy decisions,
 * ledger usage persistence, and Phase 20/21 regression.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";

beforeAll(async () => {
  await useIsolatedDb("policies");
});

const DEV_KEY = "test-dev-key";

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

async function createCredential(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
) {
  const res = await request(app)
    .post(`/api/v1/agents/${agentId}/credentials`)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(res.status).toBe(201);
  const meta = res.body.data.metadata.credentialId as string;
  return `${meta}.${res.body.data.secret as string}`;
}

const BASE_ACTIVITY = {
  activityId: "act-pol-1",
  occurredAt: "2026-10-07T12:00:00.000Z",
  actionType: "transfer",
  action: "pay-vendor",
  tool: "transfers",
  amountMinorUnits: "100",
  policyContext: {
    policyVersion: "bond-policy-v1",
    allowedActions: ["pay-vendor"],
    declaredTools: ["transfers"],
    spendLimitMinorUnits: "1000000",
  },
};

describe("A. policy lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates, reads, amends by versioning, and lists history", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-life");
    const agentId = await registerAgent(app, token, "ext-pol-life");

    const missing = await request(app)
      .get(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: {
          allowedProviders: ["acme"],
          allowedModels: ["acme-small"],
          maxInputTokens: 100000,
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      agentId,
      version: 1,
      status: "active",
    });

    const read = await request(app)
      .get(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body.data.fields.allowedProviders).toEqual(["acme"]);

    const stale = await request(app)
      .patch(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedVersion: 99, policy: { maxInputTokens: 50 } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("POLICY_VERSION_CONFLICT");

    const amended = await request(app)
      .patch(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedVersion: 1, policy: { maxInputTokens: 50 } });
    expect(amended.status).toBe(200);
    expect(amended.body.data.version).toBe(2);
    expect(amended.body.data.fields.maxInputTokens).toBe(50);
    // Untouched fields carry over (amendment, not replacement).
    expect(amended.body.data.fields.allowedProviders).toEqual(["acme"]);

    const history = await request(app)
      .get(`/api/v1/agents/${agentId}/policy/history`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);
    expect(
      history.body.data.map((p: { version: number }) => p.version),
    ).toEqual([2, 1]);
    expect(history.body.data[1]?.status).toBe("superseded");
  });

  it("replays identical creation under one idempotency key", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-idem");
    const agentId = await registerAgent(app, token, "ext-pol-idem");
    const first = await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "pol-key-1")
      .send({ policy: { maxInputTokens: 10 } });
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "pol-key-1")
      .send({ policy: { maxInputTokens: 10 } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.policyId).toBe(first.body.data.policyId);
    const count: { rows: { n: string }[] } = await query(
      "SELECT COUNT(*) AS n FROM agent_policies WHERE agent_id = $1",
      [agentId],
    );
    expect(count.rows[0]?.n).toBe("1");
  });

  it("concurrent creations never fork versions", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-race");
    const agentId = await registerAgent(app, token, "ext-pol-race");
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(app)
          .post(`/api/v1/agents/${agentId}/policy`)
          .set("Authorization", `Bearer ${token}`)
          .send({ policy: { maxInputTokens: 10 + i } }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    // Timing decides how many serialize vs conflict; the invariant
    // is no fork: unique sequential versions, conflicts well-formed.
    expect(ok.length + conflicted.length).toBe(4);
    const versions = ok.map((r) => r.body.data.version as number).sort();
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual(
      Array.from({ length: versions.length }, (_, i) => i + 1),
    );
    for (const c of conflicted) {
      expect(c.body.code).toBe("POLICY_VERSION_CONFLICT");
    }
    const count: { rows: { n: string }[] } = await query(
      "SELECT COUNT(*) AS n FROM agent_policies WHERE agent_id = $1",
      [agentId],
    );
    expect(count.rows[0]?.n).toBe(String(ok.length));
  });
});

describe("B. validation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects malformed policies with INVALID_POLICY", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-val");
    const agentId = await registerAgent(app, token, "ext-pol-val");
    for (const policy of [
      { maxInputTokens: -5 },
      { maxInputTokens: 1.5 },
      { requestWindowSeconds: 30 },
      { maxRequestsPerWindow: 10 },
      { maxCostMinorUnitsPerRequest: "-1" },
      { maxCostMinorUnitsPerRequest: "1.5" },
      { allowedProviders: [""] },
      { allowedProviders: ["ok", 42] },
      { maxTransferMinorUnits: "lots" },
    ]) {
      const res = await request(app)
        .post(`/api/v1/agents/${agentId}/policy`)
        .set("Authorization", `Bearer ${token}`)
        .send({ policy });
      expect(res.status, JSON.stringify(policy)).toBe(400);
      expect(res.body.code).toBe("INVALID_POLICY");
    }
  });

  it("rejects half-paired windows and honors explicit-null clearing", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-pair");
    const agentId = await registerAgent(app, token, "ext-pol-pair");
    const half = await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({ policy: { maxRequestsPerWindow: 5 } });
    expect(half.status).toBe(400);

    const full = await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: { maxRequestsPerWindow: 5, requestWindowSeconds: 60 },
      });
    expect(full.status).toBe(201);
    const cleared = await request(app)
      .patch(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedVersion: 1, policy: { maxRequestsPerWindow: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.fields.maxRequestsPerWindow).toBeNull();
    expect(cleared.body.data.fields.requestWindowSeconds).toBeNull();
  });
});

describe("C. authorization and isolation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("agents read own policy but never mutate; operators stay scoped", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-pol-alice");
    const bob = await sessionFor(app, "op-pol-bob");
    const agentA = await registerAgent(app, alice, "ext-pol-a");
    const agentB = await registerAgent(app, bob, "ext-pol-b");
    await request(app)
      .post(`/api/v1/agents/${agentA}/policy`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ policy: { maxInputTokens: 100 } });
    const credA = await createCredential(app, alice, agentA);

    const own = await request(app)
      .get(`/api/v1/agents/${agentA}/policy`)
      .set("Authorization", `Bearer ${credA}`);
    expect(own.status).toBe(200);
    expect(own.body.data.version).toBe(1);

    const cross = await request(app)
      .get(`/api/v1/agents/${agentB}/policy`)
      .set("Authorization", `Bearer ${credA}`);
    expect(cross.status).toBe(403);

    for (const [method, path, body] of [
      ["post", `/api/v1/agents/${agentA}/policy`, { policy: {} }],
      [
        "patch",
        `/api/v1/agents/${agentA}/policy`,
        { expectedVersion: 1, policy: {} },
      ],
    ] as const) {
      // Agent bearers are not operator sessions: rejected at session
      // lookup (401), before any policy logic runs.
      const pending = request(app)[method](path);
      const denied = await pending
        .set("Authorization", `Bearer ${credA}`)
        .send(body);
      expect(denied.status).toBe(401);
    }

    const foreign = await request(app)
      .get(`/api/v1/agents/${agentB}/policy`)
      .set("Authorization", `Bearer ${alice}`);
    expect(foreign.status).toBe(403);
    const foreignHistory = await request(app)
      .get(`/api/v1/agents/${agentB}/policy/history`)
      .set("Authorization", `Bearer ${alice}`);
    expect(foreignHistory.status).toBe(403);
  });
});

describe("D. enforcement and risk integration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("no policy means legacy v1 behavior with empty policy decision", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-legacy");
    const agentId = await registerAgent(app, token, "ext-pol-legacy");
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: BASE_ACTIVITY });
    expect(res.status).toBe(201);
    expect(res.body.data.policy).toMatchObject({
      allowed: true,
      source: "none",
      violations: [],
    });
    const rows: {
      rows: { ruleset_version: string; scoring_version: string }[];
    } = await query(
      "SELECT ruleset_version, scoring_version FROM risk_analyses WHERE id = $1",
      [res.body.data.analysisId],
    );
    expect(rows.rows[0]?.ruleset_version).toBe("ruleset-v1");
    expect(rows.rows[0]?.scoring_version).toBe("scoring-v1");
  });

  it("persisted denies override permissive caller context (server authority)", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-auth");
    const agentId = await registerAgent(app, token, "ext-pol-auth");
    // Caller context allows everything; persisted policy denies the
    // action. The effective context must still flag it.
    await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: {
          allowedActions: ["read-file"],
          spendLimitMinorUnits: undefined,
        },
      });
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: BASE_ACTIVITY });
    expect(res.status).toBe(201);
    expect(res.body.data.flagIds.length).toBeGreaterThan(0);
    const flags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    const ruleKinds = (flags.body.data as { modelVersion: string }[]).map(
      (f) => f.modelVersion,
    );
    // v1 rule fires through the effective context (server lists win).
    expect(ruleKinds.some((v) => v.includes("ruleset/ruleset-v1"))).toBe(true);
    expect(res.body.data.policy.source).toBe("agent-policy");
  });

  it("disallowed models and token overuse become v3 policy findings", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-model");
    const agentId = await registerAgent(app, token, "ext-pol-model");
    await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: {
          allowedProviders: ["acme"],
          allowedModels: ["acme-small"],
          maxInputTokens: 100000,
          maxTotalTokensPerWindow: 1000000,
          tokenWindowSeconds: 3600,
        },
      });
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        activity: {
          ...BASE_ACTIVITY,
          activityId: "act-pol-model-1",
          provider: "rival",
          model: "rival-giant",
          inputTokens: 150000,
          totalTokens: 150000,
        },
      });
    expect(res.status).toBe(201);
    const policy = res.body.data.policy as {
      allowed: boolean;
      policyVersion: string;
      violations: { ruleId: string; observed: string; limit: string }[];
    };
    expect(policy.allowed).toBe(false);
    expect(policy.policyVersion).toBe("agent-policy-v1");
    expect(policy.violations.map((v) => v.ruleId).sort()).toEqual([
      "policy-input-token-limit",
      "policy-model-denied",
      "policy-provider-denied",
    ]);
    const model = policy.violations.find(
      (v) => v.ruleId === "policy-model-denied",
    );
    expect(model).toMatchObject({ observed: "rival-giant" });
    const rows: {
      rows: { ruleset_version: string; scoring_version: string }[];
    } = await query(
      "SELECT ruleset_version, scoring_version FROM risk_analyses WHERE id = $1",
      [res.body.data.analysisId],
    );
    expect(rows.rows[0]?.ruleset_version).toBe("ruleset-v3");
    expect(rows.rows[0]?.scoring_version).toBe("scoring-v3");
    const flags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    const versions = (flags.body.data as { modelVersion: string }[]).map(
      (f) => f.modelVersion,
    );
    expect(versions.some((v) => v.includes("ruleset-v3"))).toBe(true);
    expect(versions.some((v) => v.includes("scoring-v3"))).toBe(true);
    // Usage columns persisted for cumulative windows.
    const ledger: { rows: { provider: string; total_tokens: string }[] } =
      await query(
        "SELECT provider, total_tokens FROM agent_activity_ledger WHERE analysis_id = $1",
        [res.body.data.analysisId],
      );
    expect(ledger.rows[0]).toMatchObject({
      provider: "rival",
      total_tokens: "150000",
    });
  });

  it("cumulative cost windows fire from server-side aggregates", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-cost");
    const agentId = await registerAgent(app, token, "ext-pol-cost");
    await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: {
          maxCostMinorUnitsPerWindow: "500",
          costWindowSeconds: 3600,
        },
      });
    let last: request.Response = null as never;
    for (let i = 0; i < 3; i += 1) {
      last = await request(app)
        .post("/api/v1/risk/analyses")
        .set("Authorization", `Bearer ${token}`)
        .send({
          agentId,
          activity: {
            ...BASE_ACTIVITY,
            activityId: `act-pol-cost-${i}`,
            estimatedCostMinorUnits: "200",
          },
        });
      expect(last.status).toBe(201);
    }
    // 200 + 200 + 200 = 600 > 500 → cumulative cost fires on the 3rd.
    const violations = (
      last.body.data.policy as {
        violations: { ruleId: string }[];
      }
    ).violations.map((v) => v.ruleId);
    expect(violations).toContain("policy-cumulative-cost");
  });

  it("policy violations emit audit events and observed reputation effects", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-audit");
    const agentId = await registerAgent(app, token, "ext-pol-audit");
    await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({ policy: { allowedModels: ["acme-small"] } });
    await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        activity: {
          ...BASE_ACTIVITY,
          activityId: "act-pol-audit-1",
          provider: "acme",
          model: "rival-giant",
        },
      });
    const events = await request(app)
      .get("/api/v1/events?type=POLICY_VIOLATION")
      .set("Authorization", `Bearer ${token}`);
    expect(events.status).toBe(200);
    expect(events.body.data.events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(events.body.data)).not.toContain("rival-giant");
    // Observed (not verified): small reputation dip via existing hook.
    const rep = await request(app)
      .get(`/api/v1/agents/${agentId}/reputation`)
      .set("Authorization", `Bearer ${token}`);
    expect(rep.status).toBe(200);
    expect(rep.body.data.score).toBeLessThan(75);
  });
});
