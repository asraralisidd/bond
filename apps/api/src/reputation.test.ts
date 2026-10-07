/**
 * Phase 21 reputation & trust integration tests.
 *
 * Covers: baseline, observed-flag impacts, full verified cascade
 * (flag → attestation → decision → enforcement → slash), dismissal
 * exoneration, service-level idempotency + concurrency, endpoint
 * auth/isolation, limit validation, privacy hygiene, and public
 * verification regression.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { runTransactionWorkerOnce } from "./services/transactions.js";
import { applyReputationEventService } from "./services/reputation.js";

beforeAll(async () => {
  await useIsolatedDb("reputation");
});

const DEV_KEY = "test-dev-key";
const ATTESTOR_SECRET = "attestor-secret-0123456789";

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

async function registerAttestor(
  app: ReturnType<typeof createApp>,
  token: string,
) {
  const res = await request(app)
    .post("/api/v1/attestors")
    .set("Authorization", `Bearer ${token}`)
    .send({ organization: "Org A", secret: ATTESTOR_SECRET });
  expect(res.status).toBe(201);
  return res.body.data.attestorId as string;
}

function mediumActivity(id: string) {
  return {
    activityId: id,
    occurredAt: "2026-10-06T10:00:00.000Z",
    actionType: "transfer",
    action: "pay-vendor",
    amountMinorUnits: "1500",
    policyContext: {
      policyVersion: "bond-policy-v1",
      allowedActions: ["pay-vendor"],
      spendLimitMinorUnits: "1000",
    },
  };
}

function criticalActivity(id: string) {
  return {
    ...mediumActivity(id),
    amountMinorUnits: "9000",
    policyContext: {
      policyVersion: "bond-policy-v1",
      allowedActions: ["pay-vendor"],
      spendLimitMinorUnits: "100",
    },
  };
}

async function reputationOf(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
) {
  const res = await request(app)
    .get(`/api/v1/agents/${agentId}/reputation`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data as {
    agentId: string;
    score: number;
    trustLevel: string;
    version: string;
    updatedAt: string | null;
    events: {
      eventId: string;
      eventType: string;
      impact: number;
      scoreBefore: number;
      scoreAfter: number;
      reasonCode: string;
      reason: string;
      version: string;
    }[];
  };
}

describe("A. baseline", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("new agents report the documented baseline without writes", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-base");
    const agentId = await registerAgent(app, token, "ext-rep-base");
    const rep = await reputationOf(app, token, agentId);
    expect(rep).toMatchObject({
      agentId,
      score: 75,
      trustLevel: "HIGH",
      version: "reputation-v1",
      updatedAt: null,
    });
    expect(rep.events).toEqual([]);
    // Reads are read-only: no state row materialized.
    const rows: { rows: unknown[] } = await query(
      "SELECT * FROM agent_reputation WHERE agent_id = $1",
      [agentId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("benign activity preserves the baseline", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-benign");
    const agentId = await registerAgent(app, token, "ext-rep-benign");
    const analyzed = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: mediumActivity("act-rep-benign-1") });
    expect(analyzed.status).toBe(201);
    // 1500 vs 1000 → medium spend breach: observed −2.
    const rep = await reputationOf(app, token, agentId);
    expect(rep.score).toBe(73);
    expect(rep.trustLevel).toBe("HIGH");
    expect(rep.events).toHaveLength(1);
    expect(rep.events[0]).toMatchObject({
      eventType: "risk_flag_observed",
      impact: -2,
      scoreBefore: 75,
      scoreAfter: 73,
      reasonCode: "OBSERVED_MEDIUM_RISK",
      version: "reputation-v1",
    });
  });
});

describe("B. verified cascade", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("flag → attestation → decision → slash degrades with ordered weights", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-cascade");
    const agentId = await registerAgent(app, token, "ext-rep-cascade");
    // Fund a bond so enforcement has a slashable target.
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "10000" });
    const bondId = bond.body.data.bondId as string;
    const fund = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        bondId,
        idempotencyKey: "fund-rep-1",
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

    // Critical flag: 9000 vs 100 → v1 spend-breach critical (−8)
    // plus behavioral spend-velocity high (−5) → 62.
    const analyzed = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: criticalActivity("act-rep-cascade-1") });
    expect(analyzed.status).toBe(201);
    const flagId = analyzed.body.data.flagIds[0] as string;
    let rep = await reputationOf(app, token, agentId);
    expect(rep.score).toBe(62);

    const attestorId = await registerAttestor(app, token);
    const requested = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        flagId,
        attestorIds: [attestorId],
        threshold: 1,
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    const attestationId = requested.body.data.attestationId as string;
    const verdict = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", ATTESTOR_SECRET)
      .send({ attestorId, verdict: "confirm" });
    expect(verdict.body.data.status).toBe("quorum-met");
    const decided = await request(app)
      .post(`/api/v1/attestations/${attestationId}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(decided.status).toBe(201);
    // Attested critical: −20 → 42 LOW.
    rep = await reputationOf(app, token, agentId);
    expect(rep.score).toBe(42);
    expect(rep.trustLevel).toBe("LOW");
    const attested = rep.events.find(
      (e) => e.eventType === "attested_violation",
    );
    expect(attested).toMatchObject({
      impact: -20,
      scoreBefore: 62,
      scoreAfter: 42,
      reasonCode: "ATTESTED_CRITICAL_VIOLATION",
    });

    const enforce = await request(app)
      .post(`/api/v1/attestations/${attestationId}/enforce`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountMinorUnits: "10000", idempotencyKey: "enforce-rep-1" });
    expect(enforce.status).toBe(201);
    const txId = enforce.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    await runTransactionWorkerOnce(handle);
    await request(app)
      .post(`/api/v1/transactions/${txId}/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    // Critical → full-slash default → −30 → 12 VERY_LOW.
    rep = await reputationOf(app, token, agentId);
    expect(rep.score).toBe(12);
    expect(rep.trustLevel).toBe("VERY_LOW");
    const slashed = rep.events.find((e) => e.eventType === "slash_enforced");
    expect(slashed).toMatchObject({
      impact: -30,
      scoreBefore: 42,
      scoreAfter: 12,
      reasonCode: "SLASH_FULL",
    });
    // Full chain preserved, newest first (both observed flags recorded).
    expect(rep.events.map((e) => e.eventType)).toEqual([
      "slash_enforced",
      "attested_violation",
      "risk_flag_observed",
      "risk_flag_observed",
    ]);
  });
});

describe("C. dismissal exoneration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("quorum rejection dismisses the flag and restores +2", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-dismiss");
    const agentId = await registerAgent(app, token, "ext-rep-dismiss");
    const analyzed = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: mediumActivity("act-rep-dismiss-1") });
    const flagId = analyzed.body.data.flagIds[0] as string;
    const attestorId = await registerAttestor(app, token);
    const requested = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        flagId,
        attestorIds: [attestorId],
        threshold: 1,
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    const attestationId = requested.body.data.attestationId as string;
    const verdict = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", ATTESTOR_SECRET)
      .send({ attestorId, verdict: "reject" });
    expect(verdict.body.data.status).toBe("rejected");
    // 75 −2 (observed medium) +2 (dismissed) = 75.
    const rep = await reputationOf(app, token, agentId);
    expect(rep.score).toBe(75);
    expect(rep.trustLevel).toBe("HIGH");
    const dismissed = rep.events.find(
      (e) => e.eventType === "attestation_dismissed",
    );
    expect(dismissed).toMatchObject({
      impact: 2,
      scoreBefore: 73,
      scoreAfter: 75,
      reasonCode: "ATTESTATION_DISMISSED",
    });
    const flag = await request(app)
      .get(`/api/v1/risk/flags/${flagId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(flag.body.data.status).toBe("dismissed");
  });
});

describe("D. idempotency", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("duplicate and concurrent applications apply exactly once", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-idem");
    const agentId = await registerAgent(app, token, "ext-rep-idem");
    const input = {
      agentId,
      eventType: "risk_flag_observed" as const,
      sourceType: "risk_flag" as const,
      sourceId: "rf-idem-1",
      severity: "high" as const,
    };
    const first = await applyReputationEventService(input);
    expect(first.applied).toBe(true);
    expect(first.scoreAfter).toBe(70);
    const second = await applyReputationEventService(input);
    expect(second.applied).toBe(false);
    expect(second.scoreAfter).toBe(70);
    // Concurrent duplicates: exactly one winner.
    const raced = await Promise.all(
      Array.from({ length: 5 }, () =>
        applyReputationEventService({
          agentId,
          eventType: "risk_flag_observed",
          sourceType: "risk_flag",
          sourceId: "rf-idem-race",
          severity: "medium",
        }),
      ),
    );
    expect(raced.filter((r) => r.applied)).toHaveLength(1);
    const rep = await reputationOf(app, token, agentId);
    // 75 −5 (high) −2 (medium race, once) = 68.
    expect(rep.score).toBe(68);
    const count: { rows: { n: string }[] } = await query(
      `SELECT COUNT(*) AS n FROM reputation_events
       WHERE agent_id = $1 AND source_id = 'rf-idem-race'`,
      [agentId],
    );
    expect(count.rows[0]?.n).toBe("1");
  });
});

describe("E. authorization and validation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function credentialFor(
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

  it("agents read only their own reputation; operators only owned agents", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-rep-alice");
    const bob = await sessionFor(app, "op-rep-bob");
    const agentA = await registerAgent(app, alice, "ext-rep-a");
    const agentB = await registerAgent(app, bob, "ext-rep-b");
    const credA = await credentialFor(app, alice, agentA);

    const own = await request(app)
      .get(`/api/v1/agents/${agentA}/reputation`)
      .set("Authorization", `Bearer ${credA}`);
    expect(own.status).toBe(200);
    expect(own.body.data.agentId).toBe(agentA);

    const cross = await request(app)
      .get(`/api/v1/agents/${agentB}/reputation`)
      .set("Authorization", `Bearer ${credA}`);
    expect(cross.status).toBe(403);

    const foreign = await request(app)
      .get(`/api/v1/agents/${agentB}/reputation`)
      .set("Authorization", `Bearer ${alice}`);
    expect(foreign.status).toBe(403);
  });

  it("validates limits and unknown agents", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-limits");
    const agentId = await registerAgent(app, token, "ext-rep-limits");
    for (const bad of ["0", "101", "abc"]) {
      const res = await request(app)
        .get(`/api/v1/agents/${agentId}/reputation?limit=${bad}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
    }
    const missing = await request(app)
      .get("/api/v1/agents/agent-000000000000/reputation")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });
});

describe("F. privacy and public regression", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reputation payloads carry no secrets and public view is unchanged", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rep-priv");
    const agentId = await registerAgent(app, token, "ext-rep-priv");
    await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, activity: criticalActivity("act-rep-priv-1") });
    const rep = await reputationOf(app, token, agentId);
    const serialized = JSON.stringify(rep);
    for (const banned of [
      "sk-",
      "secret",
      "Bearer",
      "mnemonic",
      "transcript",
      "metadata",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(banned);
    }
    // Event feed carries ids/severity only — no reputation internals.
    const feed = await request(app)
      .get("/api/v1/events?type=REPUTATION_UPDATED")
      .set("Authorization", `Bearer ${token}`);
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.body.data)).not.toContain("reason");
    // Public verification surface unchanged (standing only, no history).
    const pub = await request(app).get(`/api/v1/public/agents/${agentId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data).not.toHaveProperty("events");
    expect(pub.body.data).not.toHaveProperty("score");
  });
});
