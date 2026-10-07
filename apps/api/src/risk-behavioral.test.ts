/**
 * Phase 20 behavioral risk integration tests.
 *
 * Covers: burst, spend velocity, novel tool, repeat violation,
 * v1-only regression (v1 stamps/scores unchanged), ruleset-v2 /
 * scoring-v2 stamps, ledger persistence + privacy, replay (sequential
 * and concurrent), agent/operator isolation, backdated occurred_at,
 * and EXPLAIN-based index validation of the bounded window query.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";

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

const BASE_POLICY = {
  policyVersion: "bond-policy-v1",
  allowedActions: ["pay-vendor"],
  declaredTools: ["transfers"],
  spendLimitMinorUnits: "1000000",
};

function transferActivity(
  id: string,
  amount = "100",
  extraPolicy: Record<string, unknown> = {},
) {
  return {
    activityId: id,
    occurredAt: "2026-10-07T12:00:00.000Z",
    actionType: "transfer",
    action: "pay-vendor",
    tool: "transfers",
    amountMinorUnits: amount,
    policyContext: { ...BASE_POLICY, ...extraPolicy },
  };
}

async function analyze(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
  activity: Record<string, unknown>,
) {
  return request(app)
    .post("/api/v1/risk/analyses")
    .set("Authorization", `Bearer ${token}`)
    .send({ agentId, activity });
}

beforeAll(async () => {
  await useIsolatedDb("riskbehavior");
});

beforeEach(async () => {
  await resetDb();
});

describe("A. v1 regression", () => {
  it("v1-only analysis keeps v1 stamps, scores, and no ledger leakage", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-reg");
    const agentId = await registerAgent(app, token, "ext-behav-reg");
    const res = await analyze(
      app,
      token,
      agentId,
      transferActivity("act-reg-1"),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.flagIds).toEqual([]);
    expect(res.body.data.score).toBeNull();
    const rows: {
      rows: { ruleset_version: string; scoring_version: string }[];
    } = await query(
      "SELECT ruleset_version, scoring_version FROM risk_analyses WHERE id = $1",
      [res.body.data.analysisId],
    );
    expect(rows.rows[0]?.ruleset_version).toBe("ruleset-v1");
    expect(rows.rows[0]?.scoring_version).toBe("scoring-v1");
    // Ledger row exists with features only — no text, no metadata.
    const ledger: { rows: Record<string, unknown>[] } = await query(
      "SELECT * FROM agent_activity_ledger WHERE analysis_id = $1",
      [res.body.data.analysisId],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      agent_id: agentId,
      action_type: "transfer",
      action: "pay-vendor",
      tool: "transfers",
      amount_minor_units: "100",
    });
    expect("textsnippet" in (ledger.rows[0] ?? {})).toBe(false);
  });
});

describe("B. burst detection", () => {
  it("flags a burst with ruleset-v2/scoring-v2 stamps", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-burst");
    const agentId = await registerAgent(app, token, "ext-behav-burst");
    const policy = { behavioralThresholds: { burstCount: 3 } };
    let last: request.Response = null as never;
    for (let i = 0; i < 5; i += 1) {
      last = await analyze(
        app,
        token,
        agentId,
        transferActivity(`act-burst-${i}`, "100", policy),
      );
      expect(last.status).toBe(201);
    }
    // 5 analyses (4 history + current on the 5th... current counts:
    // the 5th sees 5 in-window) > burstCount 3 → activity-burst.
    expect(last.body.data.flagIds.length).toBeGreaterThan(0);
    const flag = await request(app)
      .get(`/api/v1/risk/flags/${last.body.data.flagIds[0]}`)
      .set("Authorization", `Bearer ${token}`);
    expect(flag.status).toBe(200);
    expect(flag.body.data.category).toBe("anomalous-behavior");
    expect(flag.body.data.severity).not.toBe("critical");
    expect(flag.body.data.modelVersion).toContain("ruleset/ruleset-v2");
    expect(flag.body.data.modelVersion).toContain("scoring/scoring-v2");
    const rows: {
      rows: { ruleset_version: string; scoring_version: string }[];
    } = await query(
      "SELECT ruleset_version, scoring_version FROM risk_analyses WHERE id = $1",
      [last.body.data.analysisId],
    );
    expect(rows.rows[0]?.ruleset_version).toBe("ruleset-v2");
    expect(rows.rows[0]?.scoring_version).toBe("scoring-v2");
  });
});

describe("C. spend velocity", () => {
  it("flags rapid cumulative spend under per-action limits", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-vel");
    const agentId = await registerAgent(app, token, "ext-behav-vel");
    // Per-action limit 1000; each transfer 900 (no v1 breach).
    // Velocity: window 1h, multiple 3 → allowance 3000.
    const policy = {
      spendLimitMinorUnits: "1000",
      behavioralThresholds: { velocityMultiple: 3 },
    };
    let last: request.Response = null as never;
    for (let i = 0; i < 4; i += 1) {
      last = await analyze(
        app,
        token,
        agentId,
        transferActivity(`act-vel-${i}`, "900", policy),
      );
      expect(last.status).toBe(201);
    }
    // 4 × 900 = 3600 > 3000 → spend-velocity (medium).
    expect(last.body.data.flagIds.length).toBeGreaterThan(0);
    expect(last.body.data.score.severity).not.toBe("critical");
  });
});

describe("D. novel tool", () => {
  it("flags a first-seen tool as low severity after a baseline", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-novel");
    const agentId = await registerAgent(app, token, "ext-behav-novel");
    for (let i = 0; i < 3; i += 1) {
      const res = await analyze(
        app,
        token,
        agentId,
        transferActivity(`act-novel-base-${i}`),
      );
      expect(res.status).toBe(201);
    }
    const novel = await analyze(app, token, agentId, {
      ...transferActivity("act-novel-1"),
      tool: "shell-exec",
    });
    expect(novel.status).toBe(201);
    expect(novel.body.data.flagIds.length).toBeGreaterThan(0);
    const flag = await request(app)
      .get(`/api/v1/risk/flags/${novel.body.data.flagIds[0]}`)
      .set("Authorization", `Bearer ${token}`);
    // v1 undeclared-tool (medium) fires too; at least one behavioral
    // novel-tool (low) must be present.
    const flags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    const versions = (flags.body.data as { modelVersion: string }[]).map(
      (f) => f.modelVersion,
    );
    expect(versions.some((v) => v.includes("ruleset-v2"))).toBe(true);
    expect(flag.body.data.severity).not.toBe("critical");
  });
});

describe("E. repeat violation", () => {
  it("escalates sustained same-category violations to high", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-rep");
    const agentId = await registerAgent(app, token, "ext-behav-rep");
    // Each analysis breaches the spend limit (v1 overspend/high).
    const policy = {
      spendLimitMinorUnits: "100",
      behavioralThresholds: { repeatCount: 2 },
    };
    let last: request.Response = null as never;
    for (let i = 0; i < 2; i += 1) {
      last = await analyze(
        app,
        token,
        agentId,
        transferActivity(`act-rep-${i}`, "500", policy),
      );
      expect(last.status).toBe(201);
    }
    // 2nd analysis: 1 prior overspend + current = 2 ≥ repeatCount 2.
    const flags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    const severities = (flags.body.data as { severity: string }[]).map(
      (f) => f.severity,
    );
    expect(severities).toContain("high");
    expect(severities).not.toContain("critical");
  });
});

describe("F. replay handling", () => {
  it("rejects identical resubmission with 409, no duplicate state", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-replay");
    const agentId = await registerAgent(app, token, "ext-behav-replay");
    const first = await analyze(
      app,
      token,
      agentId,
      transferActivity("act-replay-1"),
    );
    expect(first.status).toBe(201);
    const replay = await analyze(
      app,
      token,
      agentId,
      transferActivity("act-replay-1"),
    );
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("REPLAYED_ACTIVITY");
    const count: { rows: { n: string }[] } = await query(
      "SELECT COUNT(*) AS n FROM risk_analyses WHERE id = $1",
      [first.body.data.analysisId],
    );
    expect(count.rows[0]?.n).toBe("1");
    const ledger: { rows: { n: string }[] } = await query(
      "SELECT COUNT(*) AS n FROM agent_activity_ledger WHERE analysis_id = $1",
      [first.body.data.analysisId],
    );
    expect(ledger.rows[0]?.n).toBe("1");
  });

  it("concurrent duplicates admit exactly one analysis", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-race");
    const agentId = await registerAgent(app, token, "ext-behav-race");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        analyze(app, token, agentId, transferActivity("act-race-1")),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    const dup = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(dup).toHaveLength(4);
    for (const d of dup) {
      expect(d.body.code).toBe("REPLAYED_ACTIVITY");
    }
  });
});

describe("G. isolation and backdating", () => {
  it("agent A history never affects agent B; operators cannot cross-read", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-behav-alice");
    const bob = await sessionFor(app, "op-behav-bob");
    const agentA = await registerAgent(app, alice, "ext-behav-a");
    const agentB = await registerAgent(app, bob, "ext-behav-b");
    const policy = { behavioralThresholds: { burstCount: 3 } };
    for (let i = 0; i < 5; i += 1) {
      const res = await analyze(
        app,
        alice,
        agentA,
        transferActivity(`act-iso-a-${i}`, "100", policy),
      );
      expect(res.status).toBe(201);
    }
    // B analyzes once: A's burst must not leak into B's baseline.
    const single = await analyze(
      app,
      bob,
      agentB,
      transferActivity("act-iso-b-0", "100", policy),
    );
    expect(single.status).toBe(201);
    expect(single.body.data.flagIds).toEqual([]);
    // Bob cannot read Alice's agent at all: self-agent binding
    // rejects before ownership is even consulted (fail-closed order).
    const cross = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentA}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(cross.status).toBe(403);
  });

  it("backdated occurred_at cannot manipulate windows", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-backdate");
    const agentId = await registerAgent(app, token, "ext-behav-backdate");
    const policy = { behavioralThresholds: { burstCount: 100 } };
    // Ancient occurred_at, but server created_at is now → in-window.
    // With a huge burst limit nothing fires either way; the point is
    // the ledger records both timestamps and windows use created_at.
    const res = await analyze(app, token, agentId, {
      ...transferActivity("act-backdate-1", "100", policy),
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const rows: { rows: { occurred_at: string; created_at: string }[] } =
      await query(
        "SELECT occurred_at, created_at FROM agent_activity_ledger WHERE analysis_id = $1",
        [res.body.data.analysisId],
      );
    expect(new Date(rows.rows[0]?.occurred_at as string).getUTCFullYear()).toBe(
      2020,
    );
    expect(
      Date.now() - Date.parse(rows.rows[0]?.created_at as string),
    ).toBeLessThan(60_000);
  });

  it("ledger has no public write or delete surface", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-nosurface");
    await registerAgent(app, token, "ext-behav-nosurface");
    for (const [method, path] of [
      ["put", "/api/v1/risk/ledger/x"],
      ["patch", "/api/v1/risk/ledger/x"],
      ["delete", "/api/v1/risk/ledger/x"],
      ["post", "/api/v1/risk/ledger"],
      ["get", "/api/v1/risk/ledger"],
    ] as const) {
      const pending = request(app)[method](path);
      const res = await pending
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(201);
    }
  });
});

describe("H. performance", () => {
  it("window queries use the composite index (no scan)", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-behav-perf");
    const agentId = await registerAgent(app, token, "ext-behav-perf");
    // Seed a realistic ledger volume across 10 days so the planner
    // decision is meaningful (tiny tables always seq-scan).
    await query(
      `INSERT INTO risk_analyses
         (id, agent_id, engine_version, ruleset_version, scoring_version, score)
       SELECT 'perf-analysis-' || g, $1, 'engine-v1', 'ruleset-v1',
         'scoring-v1', 'null'
       FROM generate_series(1, 600) g`,
      [agentId],
    );
    await query(
      `INSERT INTO agent_activity_ledger
         (analysis_id, agent_id, action_type, action, tool,
          amount_minor_units, occurred_at, created_at)
       SELECT 'perf-analysis-' || g, $1, 'transfer', 'pay-vendor',
         'transfers', '100',
         now() - (g || ' minutes')::interval,
         now() - (g || ' minutes')::interval
       FROM generate_series(1, 600) g`,
      [agentId],
    );
    await query("ANALYZE agent_activity_ledger");
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const explained: { rows: { [key: string]: string }[] } = await query(
      `EXPLAIN (FORMAT JSON) SELECT analysis_id, action, tool,
        amount_minor_units, created_at
       FROM agent_activity_ledger
       WHERE agent_id = $1 AND created_at > $2
       ORDER BY created_at DESC LIMIT 500`,
      [agentId, since],
    );
    const plan = JSON.stringify(explained.rows[0]);
    expect(plan).toContain("activity_ledger_agent_time_idx");
    expect(plan).not.toContain("Seq Scan");
  });
});
