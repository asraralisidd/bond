/**
 * Phase 23 multi-agent delegation integration tests.
 *
 * Covers: valid delegation + delegated submit with attribution,
 * possession-gated creation, escalation rejection, scope/expiry/
 * revocation enforcement, wrong-delegate and cross-operator denial,
 * live possession rechecks, replay + concurrency safety, policy and
 * risk integration under delegation, reputation attribution,
 * management-endpoint auth, idempotency, audit events, and privacy.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";

beforeAll(async () => {
  await useIsolatedDb("delegations");
});

const DEV_KEY = "test-dev-key";
const FUTURE = "2026-12-31T00:00:00.000Z";

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

async function credentialFor(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
  capabilities?: string[],
) {
  const res = await request(app)
    .post(`/api/v1/agents/${agentId}/credentials`)
    .set("Authorization", `Bearer ${token}`)
    .send(capabilities === undefined ? {} : { capabilities });
  expect(res.status).toBe(201);
  const meta = res.body.data.metadata.credentialId as string;
  return `${meta}.${res.body.data.secret as string}`;
}

async function createDelegation(
  app: ReturnType<typeof createApp>,
  token: string,
  delegatorId: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post(`/api/v1/agents/${delegatorId}/delegations`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function benignActivity(id: string) {
  return {
    activityId: id,
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
}

describe("A. lifecycle and happy path", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates, reads, lists, and attributes delegated activity", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-happy");
    const agentA = await registerAgent(app, token, "ext-dlg-a");
    const agentB = await registerAgent(app, token, "ext-dlg-b");
    const credA = await credentialFor(app, token, agentA, [
      "activity:submit",
      "risk:read",
    ]);
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);

    const created = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    expect(created.status).toBe(201);
    const delegationId = created.body.data.delegationId as string;
    expect(created.body.data).toMatchObject({
      delegatorAgentId: agentA,
      delegateAgentId: agentB,
      status: "active",
      version: 1,
      protocolVersion: "delegation-v1",
    });

    // B cannot submit without the delegation (no activity:submit).
    const denied = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({ agentId: agentB, activity: benignActivity("act-dlg-1") });
    expect(denied.status).toBe(403);

    // With the delegation: success with full attribution.
    const analyzed = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: benignActivity("act-dlg-1"),
      });
    expect(analyzed.status).toBe(201);
    expect(analyzed.body.data.attribution).toEqual({
      requesterAgentId: agentA,
      executorAgentId: agentB,
      delegationId,
    });
    const ledger: { rows: Record<string, string | null>[] } = await query(
      `SELECT requester_agent_id, delegation_id, agent_id
       FROM agent_activity_ledger WHERE analysis_id = $1`,
      [analyzed.body.data.analysisId],
    );
    expect(ledger.rows[0]).toMatchObject({
      agent_id: agentB,
      requester_agent_id: agentA,
      delegation_id: delegationId,
    });

    // Delegate inspects its own delegation; reads A's flags through it.
    const seen = await request(app)
      .get(`/api/v1/delegations/${delegationId}`)
      .set("Authorization", `Bearer ${credB}`);
    expect(seen.status).toBe(200);
    const listed = await request(app)
      .get(`/api/v1/agents/${agentB}/delegations?role=delegate`)
      .set("Authorization", `Bearer ${credB}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    void credA;
  });
});

describe("B. escalation and possession", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects capabilities outside the closed set", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-closed");
    const agentA = await registerAgent(app, token, "ext-dlg-ca");
    const agentB = await registerAgent(app, token, "ext-dlg-cb");
    for (const capabilities of [
      ["enforcement"],
      ["bond:withdraw"],
      ["policy:write"],
      ["credential:manage"],
      ["activity:submit", "enforcement"],
      [],
    ]) {
      const res = await createDelegation(app, token, agentA, {
        delegateAgentId: agentB,
        capabilities,
        expiresAt: FUTURE,
      });
      expect(res.status, JSON.stringify(capabilities)).toBe(400);
      expect(res.body.code).toBe("INVALID_DELEGATION");
    }
  });

  it("rejects delegating unpossessed capabilities, even for operators", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-possess");
    const agentA = await registerAgent(app, token, "ext-dlg-pa");
    const agentB = await registerAgent(app, token, "ext-dlg-pb");
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const res = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit", "reputation:read"],
      expiresAt: FUTURE,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DELEGATION_DENIED");
    const audit = await request(app)
      .get("/api/v1/events?type=delegation.capability_denied")
      .set("Authorization", `Bearer ${token}`);
    expect(audit.status).toBe(200);
    expect(audit.body.data.events.length).toBeGreaterThanOrEqual(1);
  });

  it("agent creators delegate only as themselves from live caps", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-self");
    const agentA = await registerAgent(app, token, "ext-dlg-sa");
    const agentB = await registerAgent(app, token, "ext-dlg-sb");
    const credA = await credentialFor(app, token, agentA, ["activity:submit"]);
    // A delegates to B as itself: allowed.
    const ok = await request(app)
      .post(`/api/v1/agents/${agentA}/delegations`)
      .set("Authorization", `Bearer ${credA}`)
      .send({
        delegateAgentId: agentB,
        capabilities: ["activity:submit"],
        expiresAt: FUTURE,
      });
    expect(ok.status).toBe(201);
    expect(ok.body.data.createdBy).toBe(`agent:${agentA}`);
    // A cannot create delegations as B.
    const forged = await request(app)
      .post(`/api/v1/agents/${agentB}/delegations`)
      .set("Authorization", `Bearer ${credA}`)
      .send({
        delegateAgentId: agentA,
        capabilities: ["activity:submit"],
        expiresAt: FUTURE,
      });
    expect(forged.status).toBe(403);
    // A cannot delegate a capability it does not hold.
    const overreach = await request(app)
      .post(`/api/v1/agents/${agentA}/delegations`)
      .set("Authorization", `Bearer ${credA}`)
      .send({
        delegateAgentId: agentB,
        capabilities: ["risk:read"],
        expiresAt: FUTURE,
      });
    expect(overreach.status).toBe(403);
  });

  it("revoking the delegator credential fail-closes live use", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-recheck");
    const agentA = await registerAgent(app, token, "ext-dlg-ra");
    const agentB = await registerAgent(app, token, "ext-dlg-rb");
    const created = await request(app)
      .post(`/api/v1/agents/${agentA}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["activity:submit"] });
    const credA = `${created.body.data.metadata.credentialId as string}.${created.body.data.secret as string}`;
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    const delegationId = dlg.body.data.delegationId as string;
    void credA;
    // A loses its only capability-bearing credential.
    const list = await request(app)
      .get(`/api/v1/agents/${agentA}/credentials`)
      .set("Authorization", `Bearer ${token}`);
    for (const row of list.body.data as { credentialId: string }[]) {
      await request(app)
        .delete(`/api/v1/agents/${agentA}/credentials/${row.credentialId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
    }
    const use = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: benignActivity("act-dlg-recheck-1"),
      });
    expect(use.status).toBe(403);
    expect(use.body.code).toBe("DELEGATION_DENIED");
  });
});

describe("C. scope, expiry, revocation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function pair(suffix: string) {
    const app = createApp();
    const token = await sessionFor(app, `op-dlg-${suffix}`);
    const agentA = await registerAgent(app, token, `ext-dlg-${suffix}-a`);
    const agentB = await registerAgent(app, token, `ext-dlg-${suffix}-b`);
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);
    return { app, token, agentA, agentB, credB };
  }

  it("enforces tool scope without touching policy", async () => {
    const { app, token, agentA, agentB, credB } = await pair("scope");
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
      scope: { tools: ["transfers"] },
    });
    const delegationId = dlg.body.data.delegationId as string;
    const ok = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: benignActivity("act-dlg-scope-1"),
      });
    expect(ok.status).toBe(201);
    const over = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: {
          ...benignActivity("act-dlg-scope-2"),
          tool: "shell-exec",
        },
      });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe("DELEGATION_DENIED");
  });

  it("rejects expired delegations and past-dated creation", async () => {
    const { app, token, agentA, agentB, credB } = await pair("expiry");
    const past = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(past.status).toBe(400);
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    const delegationId = dlg.body.data.delegationId as string;
    await query(
      "UPDATE delegations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [delegationId],
    );
    const use = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: benignActivity("act-dlg-exp-1"),
      });
    expect(use.status).toBe(403);
    const read = await request(app)
      .get(`/api/v1/delegations/${delegationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.body.data.status).toBe("expired");
  });

  it("revocation is immediate, durable, and idempotent", async () => {
    const { app, token, agentA, agentB, credB } = await pair("revoke");
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    const delegationId = dlg.body.data.delegationId as string;
    const revoked = await request(app)
      .post(`/api/v1/delegations/${delegationId}/revoke`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "no longer needed" });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.status).toBe("revoked");
    expect(revoked.body.data.version).toBe(2);
    const again = await request(app)
      .post(`/api/v1/delegations/${delegationId}/revoke`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe("revoked");
    expect(again.body.data.version).toBe(2);
    const use = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: benignActivity("act-dlg-rev-1"),
      });
    expect(use.status).toBe(403);
    // The delegate cannot revoke: only the delegator (or operator).
    const selfRevoke = await request(app)
      .post(`/api/v1/delegations/${delegationId}/revoke`)
      .set("Authorization", `Bearer ${credB}`)
      .send({});
    expect(selfRevoke.status).toBe(403);
  });

  it("wrong delegate and cross-operator use fail closed", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-dlg-xa");
    const bob = await sessionFor(app, "op-dlg-xb");
    const agentA = await registerAgent(app, alice, "ext-dlg-xa");
    const agentB = await registerAgent(app, alice, "ext-dlg-xb");
    const agentC = await registerAgent(app, alice, "ext-dlg-xc");
    const agentForeign = await registerAgent(app, bob, "ext-dlg-xf");
    await credentialFor(app, alice, agentA, ["activity:submit"]);
    const credC = await credentialFor(app, alice, agentC, ["agent:read"]);
    // Cross-operator creation fails on ownership.
    const cross = await createDelegation(app, alice, agentA, {
      delegateAgentId: agentForeign,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    expect([403, 404]).toContain(cross.status);
    const dlg = await createDelegation(app, alice, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    // C presents B's delegation: generic denial, no existence leak.
    const wrong = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credC}`)
      .send({
        agentId: agentC,
        delegationId: dlg.body.data.delegationId,
        activity: benignActivity("act-dlg-x-1"),
      });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("DELEGATION_DENIED");
    // Bob cannot inspect Alice's delegation.
    const peek = await request(app)
      .get(`/api/v1/delegations/${dlg.body.data.delegationId as string}`)
      .set("Authorization", `Bearer ${bob}`);
    expect([403, 404]).toContain(peek.status);
  });
});

describe("D. replay, concurrency, idempotency", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("replays stay rejected and concurrent use stays consistent", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-conc");
    const agentA = await registerAgent(app, token, "ext-dlg-conca");
    const agentB = await registerAgent(app, token, "ext-dlg-concb");
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    const delegationId = dlg.body.data.delegationId as string;
    const submit = (id: string) =>
      request(app)
        .post("/api/v1/risk/analyses")
        .set("Authorization", `Bearer ${credB}`)
        .send({ agentId: agentB, delegationId, activity: benignActivity(id) });
    const first = await submit("act-dlg-conc-1");
    expect(first.status).toBe(201);
    const replay = await submit("act-dlg-conc-1");
    expect(replay.status).toBe(409);
    const raced = await Promise.all(
      Array.from({ length: 5 }, (_, i) => submit(`act-dlg-conc-r${i}`)),
    );
    expect(raced.every((r) => r.status === 201)).toBe(true);
    for (const r of raced) {
      expect(r.body.data.attribution.delegationId).toBe(delegationId);
    }
    // Revoke mid-flight: racing uses never corrupt state.
    const mixed = await Promise.all([
      ...Array.from({ length: 3 }, (_, i) => submit(`act-dlg-conc-m${i}`)),
      request(app)
        .post(`/api/v1/delegations/${delegationId}/revoke`)
        .set("Authorization", `Bearer ${token}`)
        .send({}),
    ]);
    for (const r of mixed) {
      expect([200, 201, 403]).toContain(r.status);
    }
    const after = await submit("act-dlg-conc-after");
    expect(after.status).toBe(403);
  });

  it("creation replays under one idempotency key", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-ikey");
    const agentA = await registerAgent(app, token, "ext-dlg-ika");
    const agentB = await registerAgent(app, token, "ext-dlg-ikb");
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const body = {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    };
    const first = await request(app)
      .post(`/api/v1/agents/${agentA}/delegations`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "dlg-key-1")
      .send(body);
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post(`/api/v1/agents/${agentA}/delegations`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "dlg-key-1")
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.delegationId).toBe(
      first.body.data.delegationId as string,
    );
    const count: { rows: { n: string }[] } = await query(
      "SELECT COUNT(*) AS n FROM delegations WHERE delegator_agent_id = $1",
      [agentA],
    );
    expect(count.rows[0]?.n).toBe("1");
  });
});

describe("E. policy, risk, and reputation integration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("executor policy still governs; violations attribute to the executor", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-pol");
    const agentA = await registerAgent(app, token, "ext-dlg-pola");
    const agentB = await registerAgent(app, token, "ext-dlg-polb");
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);
    // B's own policy denies the tool A delegated. Delegation grants
    // the capability; policy still denies the operation.
    await request(app)
      .post(`/api/v1/agents/${agentB}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({ policy: { deniedTools: ["transfers"] } });
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
      scope: { tools: ["transfers", "shell-exec"] },
    });
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId: dlg.body.data.delegationId,
        activity: benignActivity("act-dlg-pol-1"),
      });
    expect(res.status).toBe(201);
    // v1 undeclared-tool fires through the effective context: the
    // persisted deny subtracts transfers from the declared list.
    expect(res.body.data.flagIds.length).toBeGreaterThan(0);
    expect(res.body.data.attribution.requesterAgentId).toBe(agentA);
    // Reputation follows the executor (B dips); the delegator (A)
    // keeps its baseline with no automatic blame.
    const repB = await request(app)
      .get(`/api/v1/agents/${agentB}/reputation`)
      .set("Authorization", `Bearer ${token}`);
    expect(repB.body.data.score).toBeLessThan(75);
    const repA = await request(app)
      .get(`/api/v1/agents/${agentA}/reputation`)
      .set("Authorization", `Bearer ${token}`);
    expect(repA.body.data.score).toBe(75);
    expect(repA.body.data.events).toEqual([]);
  });

  it("delegated reads work for the delegator scope only", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-read");
    const agentA = await registerAgent(app, token, "ext-dlg-rda");
    const agentB = await registerAgent(app, token, "ext-dlg-rdb");
    const agentC = await registerAgent(app, token, "ext-dlg-rdc");
    await credentialFor(app, token, agentA, ["activity:submit", "risk:read"]);
    const credB = await credentialFor(app, token, agentB, [
      "agent:read",
      "risk:read",
    ]);
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit", "risk:read"],
      expiresAt: FUTURE,
    });
    const delegationId = dlg.body.data.delegationId as string;
    // A flags itself (operator-submitted); B reads A's flags through
    // the delegation, and its own flags directly.
    const flagged = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId: agentA,
        activity: {
          ...benignActivity("act-dlg-read-1"),
          amountMinorUnits: "9000",
          policyContext: {
            ...benignActivity("act-dlg-read-1").policyContext,
            spendLimitMinorUnits: "100",
          },
        },
      });
    expect(flagged.body.data.flagIds.length).toBeGreaterThan(0);
    const delegated = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentA}&delegationId=${delegationId}`)
      .set("Authorization", `Bearer ${credB}`);
    expect(delegated.status).toBe(200);
    expect(delegated.body.data.length).toBeGreaterThan(0);
    // B cannot pivot the same delegation to read C's flags.
    const pivot = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentC}&delegationId=${delegationId}`)
      .set("Authorization", `Bearer ${credB}`);
    expect(pivot.status).toBe(403);
  });

  it("delegation grants no policy, bond, or enforcement authority", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-priv");
    const agentA = await registerAgent(app, token, "ext-dlg-pva");
    const agentB = await registerAgent(app, token, "ext-dlg-pvb");
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);
    await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    // Policy mutation, bonds, and transactions stay operator-only:
    // an agent bearer fails before delegation is even consulted.
    for (const attempt of [
      request(app)
        .patch(`/api/v1/agents/${agentB}/policy`)
        .set("Authorization", `Bearer ${credB}`)
        .send({ expectedVersion: 1, policy: {} }),
      request(app)
        .post("/api/v1/bonds")
        .set("Authorization", `Bearer ${credB}`)
        .send({ agentId: agentB, commitmentMinorUnits: "100" }),
      request(app)
        .post("/api/v1/transactions")
        .set("Authorization", `Bearer ${credB}`)
        .send({ purpose: "FUND_BOND", agentId: agentB }),
    ]) {
      const res = await attempt;
      expect([401, 403]).toContain(res.status);
    }
  });
});

describe("F. privacy and audit", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("payloads and events carry ids only; public surface unchanged", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-dlg-priv2");
    const agentA = await registerAgent(app, token, "ext-dlg-qa");
    const agentB = await registerAgent(app, token, "ext-dlg-qb");
    await credentialFor(app, token, agentA, ["activity:submit"]);
    const credB = await credentialFor(app, token, agentB, ["agent:read"]);
    const dlg = await createDelegation(app, token, agentA, {
      delegateAgentId: agentB,
      capabilities: ["activity:submit"],
      expiresAt: FUTURE,
    });
    await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId: dlg.body.data.delegationId,
        activity: benignActivity("act-dlg-q-1"),
      });
    const feed = await request(app)
      .get("/api/v1/events?type=delegation.created")
      .set("Authorization", `Bearer ${token}`);
    expect(feed.status).toBe(200);
    expect(feed.body.data.events.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(feed.body.data);
    for (const banned of ["secret", "Bearer", "mnemonic", "private"]) {
      expect(serialized.toLowerCase()).not.toContain(banned);
    }
    const pub = await request(app).get(`/api/v1/public/agents/${agentB}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body.data)).not.toContain("delegation");
  });
});
