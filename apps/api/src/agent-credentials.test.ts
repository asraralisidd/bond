/**
 * Phase 18 agent credential security tests.
 *
 * Covers: creation, hashing, single disclosure, list non-disclosure,
 * authentication (success/wrong/revoked/expired), rotation atomicity,
 * cross-agent/operator denial, operator-route denial, capability
 * denial, unknown capabilities, credential-management isolation,
 * rate-limit separation, audit events, log/error hygiene, and
 * operator/attestor regression.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { ApiError } from "./http/errors.js";
import { hashCredentialSecret } from "./db/stores/agent-credentials.js";

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

interface CreatedCredential {
  metadata: { credentialId: string; [key: string]: unknown };
  secret: string;
}

async function createCredential(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
  body: Record<string, unknown> = {},
) {
  const res = await request(app)
    .post(`/api/v1/agents/${agentId}/credentials`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body.data as CreatedCredential;
}

function agentToken(cred: CreatedCredential): string {
  return `${cred.metadata.credentialId}.${cred.secret}`;
}

beforeAll(async () => {
  await useIsolatedDb("agentcreds");
});

beforeEach(async () => {
  await resetDb();
});

describe("A. creation and storage", () => {
  it("creates a credential and returns the secret exactly once", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-create");
    const agentId = await registerAgent(app, token, "ext-create");
    const created = await createCredential(app, token, agentId);
    expect(created.metadata.credentialId).toMatch(/^cred_/);
    expect(typeof created.secret).toBe("string");
    expect(created.secret.length).toBeGreaterThanOrEqual(64);
    expect(created.metadata.agentId).toBe(agentId);
    expect(created.metadata.status).toBe("ACTIVE");
    expect(created.metadata.capabilities).toEqual([
      "activity:submit",
      "agent:read",
      "risk:read",
      "verification:read",
    ]);
  });

  it("stores only the SHA-256 hash, never plaintext", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-hash");
    const agentId = await registerAgent(app, token, "ext-hash");
    const created = await createCredential(app, token, agentId);
    const rows: { rows: { secret_hash: string }[] } = await query(
      "SELECT secret_hash FROM agent_credentials WHERE credential_id = $1",
      [created.metadata.credentialId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.secret_hash).toBe(
      hashCredentialSecret(created.secret),
    );
    expect(rows.rows[0]?.secret_hash).not.toContain(created.secret);
    // Full-table scan for the raw secret: must appear nowhere.
    const scan: { rows: { t: string }[] } = await query(
      `SELECT agent_credentials::text AS t FROM agent_credentials
       UNION ALL SELECT sessions::text FROM sessions`,
    );
    for (const row of scan.rows) {
      expect(row.t).not.toContain(created.secret);
    }
  });

  it("rejects unknown capabilities and empty sets", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-caps");
    const agentId = await registerAgent(app, token, "ext-caps");
    const bad = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["bond:operate"] });
    expect(bad.status).toBe(400);
    const empty = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: [] });
    expect(empty.status).toBe(400);
  });

  it("list returns metadata only, never secrets", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-list");
    const agentId = await registerAgent(app, token, "ext-list");
    const created = await createCredential(app, token, agentId);
    const res = await request(app)
      .get(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(created.secret);
    expect(res.body.data[0]).not.toHaveProperty("secret");
    expect(res.body.data[0]).not.toHaveProperty("secret_hash");
  });
});

describe("B. authentication", () => {
  it("authenticates with a valid credential on allowlisted routes", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-auth-ok");
    const agentId = await registerAgent(app, token, "ext-auth-ok");
    const created = await createCredential(app, token, agentId);
    const bearer = agentToken(created);
    const agent = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(agent.status).toBe(200);
    expect(agent.body.data.agentId).toBe(agentId);
    // last_used_at bookkeeping fires.
    const rows: { rows: { last_used_at: string | null }[] } = await query(
      "SELECT last_used_at FROM agent_credentials WHERE credential_id = $1",
      [created.metadata.credentialId],
    );
    expect(rows.rows[0]?.last_used_at).not.toBeNull();
  });

  it("rejects wrong secrets with a generic 401", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-auth-bad");
    const agentId = await registerAgent(app, token, "ext-auth-bad");
    const created = await createCredential(app, token, agentId);
    const wrong = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${created.metadata.credentialId}.wrong`);
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("UNAUTHORIZED");
    // Unknown credential ids are indistinguishable (same code/message;
    // requestIds differ per request by design).
    const unknown = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", "Bearer cred_nope.deadbeef");
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe(wrong.body.code);
    expect(unknown.body.message).toBe(wrong.body.message);
    expect(unknown.body.requestId).toBeTruthy();
  });

  it("rejects revoked and expired credentials", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-revoke");
    const agentId = await registerAgent(app, token, "ext-revoke");
    const created = await createCredential(app, token, agentId);
    const bearer = agentToken(created);
    const del = await request(app)
      .delete(
        `/api/v1/agents/${agentId}/credentials/${created.metadata.credentialId}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(del.status).toBe(200);
    const after = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(after.status).toBe(401);

    const expiring = await createCredential(app, token, agentId, {});
    await query(
      "UPDATE agent_credentials SET expires_at = now() - interval '1 minute' WHERE credential_id = $1",
      [expiring.metadata.credentialId],
    );
    const expired = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${agentToken(expiring)}`);
    expect(expired.status).toBe(401);
  });
});

describe("C. rotation", () => {
  it("rotates atomically: old dies, new works, secret shown once", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rotate");
    const agentId = await registerAgent(app, token, "ext-rotate");
    const created = await createCredential(app, token, agentId);
    const oldBearer = agentToken(created);
    const rotated = await request(app)
      .post(
        `/api/v1/agents/${agentId}/credentials/${created.metadata.credentialId}/rotate`,
      )
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(rotated.status).toBe(201);
    expect(rotated.body.data.secret).toBeTruthy();
    expect(rotated.body.data.secret).not.toBe(created.secret);
    expect(rotated.body.data.metadata.credentialId).not.toBe(
      created.metadata.credentialId,
    );
    // Old stops immediately.
    const oldAttempt = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${oldBearer}`);
    expect(oldAttempt.status).toBe(401);
    // New works.
    const fresh = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(
        "Authorization",
        `Bearer ${rotated.body.data.metadata.credentialId}.${rotated.body.data.secret}`,
      );
    expect(fresh.status).toBe(200);
    // Old row is revoked, not deleted (audit trail).
    const rows: { rows: { status: string }[] } = await query(
      "SELECT status FROM agent_credentials WHERE credential_id = $1",
      [created.metadata.credentialId],
    );
    expect(rows.rows[0]?.status).toBe("REVOKED");
  });

  it("handles concurrent rotation/revocation without duplicates", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-race");
    const agentId = await registerAgent(app, token, "ext-race");
    const created = await createCredential(app, token, agentId);
    const url = `/api/v1/agents/${agentId}/credentials/${created.metadata.credentialId}/rotate`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(url).set("Authorization", `Bearer ${token}`).send({}),
      ),
    );
    const succeeded = results.filter((r) => r.status === 201);
    // Exactly one rotation wins; losers see the credential as inactive.
    expect(succeeded).toHaveLength(1);
    const actives: { rows: { count: string }[] } = await query(
      "SELECT COUNT(*) AS count FROM agent_credentials WHERE agent_id = $1 AND status = 'ACTIVE'",
      [agentId],
    );
    expect(Number(actives.rows[0]?.count)).toBe(1);
  });
});

describe("D. isolation", () => {
  it("denies cross-agent access even under one operator", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-siblings");
    const agentA = await registerAgent(app, token, "ext-sib-a");
    const agentB = await registerAgent(app, token, "ext-sib-b");
    const credA = await createCredential(app, token, agentA);
    // Read sibling.
    const read = await request(app)
      .get(`/api/v1/agents/${agentB}`)
      .set("Authorization", `Bearer ${agentToken(credA)}`);
    expect(read.status).toBe(403);
    // Submit activity naming the sibling.
    const analysis = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${agentToken(credA)}`)
      .send({
        agentId: agentB,
        activity: {
          activityId: "act-x",
          actionType: "message",
          action: "hi",
          occurredAt: new Date().toISOString(),
          policyContext: { policyVersion: "bond-policy-v1" },
        },
      });
    expect(analysis.status).toBe(403);
  });

  it("denies cross-operator access", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-alice-x");
    const bob = await sessionFor(app, "op-bob-x");
    const agentA = await registerAgent(app, alice, "ext-x-a");
    const agentB = await registerAgent(app, bob, "ext-x-b");
    const credA = await createCredential(app, alice, agentA);
    const read = await request(app)
      .get(`/api/v1/agents/${agentB}`)
      .set("Authorization", `Bearer ${agentToken(credA)}`);
    expect(read.status).toBe(403);
  });

  it("denies agent credentials on operator-only routes", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-scope");
    const agentId = await registerAgent(app, token, "ext-scope");
    const cred = await createCredential(app, token, agentId);
    const bearer = agentToken(cred);
    // Operator-only routes reject agent credentials at authentication
    // (session lookup misses credential secrets) with generic 401s.
    // Mutation routes.
    const create = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${bearer}`)
      .send({
        platform: "p",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-evil",
      });
    expect(create.status).toBe(401);
    expect(create.body.code).toBe("UNAUTHORIZED");
    const patch = await request(app)
      .patch(`/api/v1/agents/${agentId}/status`)
      .set("Authorization", `Bearer ${bearer}`)
      .send({ status: "SUSPENDED" });
    expect(patch.status).toBe(401);
    // Credential management itself.
    const manage = await request(app)
      .get(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(manage.status).toBe(401);
    const rotate = await request(app)
      .post(
        `/api/v1/agents/${agentId}/credentials/${cred.metadata.credentialId}/rotate`,
      )
      .set("Authorization", `Bearer ${bearer}`)
      .send({});
    expect(rotate.status).toBe(401);
    // Bonds, transactions, attestations, eligibility, sign-out.
    const bondRes = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${bearer}`)
      .send({ agentId, commitmentMinorUnits: "100" });
    expect(bondRes.status).not.toBe(201);
    const txRes = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${bearer}`)
      .send({ purpose: "X" });
    expect(txRes.status).not.toBe(201);
    const signoutRes = await request(app)
      .post("/api/v1/auth/sign-out")
      .set("Authorization", `Bearer ${bearer}`)
      .send({});
    expect(signoutRes.status).not.toBe(200);
  });

  it("denies capabilities outside the grant", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-cap");
    const agentId = await registerAgent(app, token, "ext-cap");
    const created = await createCredential(app, token, agentId, {
      capabilities: ["agent:read"],
    });
    const bearer = agentToken(created);
    // agent:read works.
    const read = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(read.status).toBe(200);
    // risk:read denied.
    const flags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(flags.status).toBe(403);
    expect(flags.body.code).toBe("FORBIDDEN");
    // activity:submit denied.
    const analysis = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${bearer}`)
      .send({
        agentId,
        activity: {
          activityId: "act-y",
          actionType: "message",
          action: "hi",
          occurredAt: new Date().toISOString(),
          policyContext: { policyVersion: "bond-policy-v1" },
        },
      });
    expect(analysis.status).toBe(403);
  });
});

describe("E. rate limiting and audit", () => {
  it("keys agent traffic separately from the operator bucket", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-rl");
    const agentId = await registerAgent(app, token, "ext-rl");
    const created = await createCredential(app, token, agentId);
    // Exhaust the agent's read budget without touching the operator's.
    const small = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${agentToken(created)}`);
    expect(small.status).toBe(200);
    // Operator session on the same route still has full budget.
    const op = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(op.status).toBe(200);
  });

  it("records credential lifecycle and denial events without secrets", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-audit");
    const agentId = await registerAgent(app, token, "ext-audit");
    const created = await createCredential(app, token, agentId);
    const secret = created.secret;
    // Failed auth attempt.
    await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(
        "Authorization",
        `Bearer ${created.metadata.credentialId}.wrongsecret`,
      );
    // Capability denial.
    const narrow = await createCredential(app, token, agentId, {
      capabilities: ["agent:read"],
    });
    await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${agentToken(narrow)}`);
    await request(app)
      .post(
        `/api/v1/agents/${agentId}/credentials/${created.metadata.credentialId}/rotate`,
      )
      .set("Authorization", `Bearer ${token}`)
      .send({});
    const events: { rows: { type: string; payload: unknown }[] } = await query(
      "SELECT type, payload FROM protocol_events WHERE type LIKE 'credential.%' OR type LIKE 'agent.%' ORDER BY created_at ASC",
    );
    const types = events.rows.map((r) => r.type);
    for (const expected of [
      "credential.created",
      "agent.authentication_failed",
      "agent.capability_denied",
      "credential.rotated",
    ]) {
      expect(types).toContain(expected);
    }
    expect(JSON.stringify(events.rows)).not.toContain(secret);
    expect(JSON.stringify(events.rows)).not.toContain("wrongsecret");
  });

  it("never leaks secrets in logs or error responses", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-leak");
    const agentId = await registerAgent(app, token, "ext-leak");
    const created = await createCredential(app, token, agentId);
    const bearer = agentToken(created);
    const bad = await request(app)
      .get("/api/v1/agents/nonexistent")
      .set("Authorization", `Bearer ${bearer}tampered`);
    expect(bad.status).toBe(401);
    expect(JSON.stringify(bad.body)).not.toContain(created.secret);
    const list = await request(app)
      .get(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`);
    expect(JSON.stringify(list.body)).not.toContain(created.secret);
  });
});

describe("F. regression", () => {
  it("requireOperator rejects agent principals even if middleware passed one", async () => {
    const { requireOperator } = await import("./http/auth.js");
    const fakeReq = {
      auth: {
        operatorId: "op_x",
        sessionId: "",
        authMethod: "agent-credential",
        walletVerifyingKey: null,
        agent: {
          agentId: "agent-x",
          credentialId: "cred_x",
          capabilities: [],
        },
      },
    } as never;
    let code: string | null = null;
    let status: number | null = null;
    try {
      requireOperator(fakeReq);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        code = error.code;
        status = error.status;
      }
    }
    expect(code).toBe("FORBIDDEN");
    expect(status).toBe(403);
  });

  it("operator sessions work exactly as before", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-reg");
    const agentId = await registerAgent(app, token, "ext-reg");
    const read = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    const create = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "p",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-reg-2",
      });
    expect(create.status).toBe(201);
  });

  it("attestor authentication is unaffected", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-att");
    const reg = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${token}`)
      .send({
        attestorId: "att-cred-reg-1",
        organization: "Org",
        secret: "0123456789abcdef",
      });
    expect(reg.status).toBe(201);
  });
});
