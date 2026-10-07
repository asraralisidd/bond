/**
 * Phase 19 delegated setup grant tests.
 *
 * Covers: creation, one-time disclosure, hash-only storage,
 * authentication, wrong secret, expiry, revocation, replay,
 * scope enforcement, operator/agent binding, no chaining, no
 * escalation, concurrent consumption (exactly one winner),
 * secret hygiene, credential policy (default/max expiry, cap,
 * rotation, metadata, compatibility), event-feed visibility,
 * cross-principal isolation, and operator/attestor regression.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { ApiError } from "./http/errors.js";
import { hashGrantSecret } from "./db/stores/setup-grants.js";

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

interface CreatedGrant {
  metadata: { grantId: string; [key: string]: unknown };
  secret: string;
}

async function createGrant(
  app: ReturnType<typeof createApp>,
  token: string,
  body: Record<string, unknown>,
): Promise<CreatedGrant> {
  const res = await request(app)
    .post("/api/v1/setup-grants")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body.data as CreatedGrant;
}

function grantBearer(grant: CreatedGrant): string {
  return `${grant.metadata.grantId}.${grant.secret}`;
}

interface CreatedAgentCredential {
  metadata: { credentialId: string };
  secret: string;
}

async function createAgentCredential(
  app: ReturnType<typeof createApp>,
  token: string,
  agentId: string,
): Promise<CreatedAgentCredential> {
  const res = await request(app)
    .post(`/api/v1/agents/${agentId}/credentials`)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(res.status).toBe(201);
  return res.body.data as CreatedAgentCredential;
}

function credentialBearer(cred: CreatedAgentCredential): string {
  return `${cred.metadata.credentialId}.${cred.secret}`;
}

beforeAll(async () => {
  await useIsolatedDb("setupgrants");
});

beforeEach(async () => {
  await resetDb();
});

describe("A. grant creation", () => {
  it("creates a grant and returns the secret exactly once", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-create");
    const res = await request(app)
      .post("/api/v1/setup-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({ scopes: ["agent:register"] });
    expect(res.status).toBe(201);
    expect(res.body.data.metadata.grantId).toMatch(/^grant_/);
    expect(typeof res.body.data.secret).toBe("string");
    expect(res.body.data.secret.length).toBeGreaterThanOrEqual(64);
    expect(res.body.data.metadata.scopes).toEqual(["agent:register"]);
  });

  it("stores only the SHA-256 hash, never plaintext", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-hash");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const rows: { rows: { secret_hash: string }[] } = await query(
      "SELECT secret_hash FROM setup_grants WHERE grant_id = $1",
      [created.metadata.grantId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.secret_hash).toBe(hashGrantSecret(created.secret));
    const scan: { rows: { t: string }[] } = await query(
      `SELECT setup_grants::text AS t FROM setup_grants
       UNION ALL SELECT protocol_events::text FROM protocol_events`,
    );
    for (const row of scan.rows) {
      expect(row.t).not.toContain(created.secret);
    }
  });

  it("rejects unknown scopes and empty scope lists", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-scope");
    for (const body of [
      { scopes: ["bond:withdraw"] },
      { scopes: ["credential:create"] },
      { scopes: [] },
      {},
    ]) {
      const res = await request(app)
        .post("/api/v1/setup-grants")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("requires agent binding for bond/attestation scopes, forbids it for register", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-bind");
    const agentId = await registerAgent(app, token, "ext-grant-bind");
    const unbound = await request(app)
      .post("/api/v1/setup-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({ scopes: ["bond:init"] });
    expect(unbound.status).toBe(400);
    const boundRegister = await request(app)
      .post("/api/v1/setup-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({ scopes: ["agent:register"], agentId });
    expect(boundRegister.status).toBe(400);
    const ok = await request(app)
      .post("/api/v1/setup-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({ scopes: ["bond:init"], agentId });
    expect(ok.status).toBe(201);
  });
});

describe("B. grant consumption", () => {
  it("registers an agent through a grant bearer", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-use");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const res = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${grantBearer(created)}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-reg",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.agentId).toBeTruthy();
  });

  it("rejects wrong secrets with a generic 401", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-wrong");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const wrong = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${created.metadata.grantId}.wrongsecret`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-wrong",
      });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("UNAUTHORIZED");
    const unknown = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", "Bearer grant_nope.deadbeef")
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-unknown",
      });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe(wrong.body.code);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it("rejects expired and revoked grants", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-exp");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    await query(
      "UPDATE setup_grants SET expires_at = now() - interval '1 minute' WHERE grant_id = $1",
      [created.metadata.grantId],
    );
    const expired = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${grantBearer(created)}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-exp",
      });
    expect(expired.status).toBe(401);

    const live = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const del = await request(app)
      .delete(`/api/v1/setup-grants/${live.metadata.grantId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(del.status).toBe(200);
    const revoked = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${grantBearer(live)}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-rev",
      });
    expect(revoked.status).toBe(401);
  });

  it("rejects replay: consumed grants fail closed", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-replay");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const bearer = grantBearer(created);
    const first = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${bearer}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-replay-1",
      });
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${bearer}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-grant-replay-2",
      });
    expect(replay.status).toBe(401);
  });

  it("concurrent consumption admits exactly one winner", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-race");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const bearer = grantBearer(created);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post("/api/v1/agents")
          .set("Authorization", `Bearer ${bearer}`)
          .send({
            platform: "custom",
            agentType: "custom",
            capabilities: [],
            externalRef: `ext-grant-race-${i}`,
          }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded).toHaveLength(1);
    for (const loser of results.filter((r) => r.status !== 201)) {
      expect(loser.status).toBe(401);
    }
  });
});

describe("C. scope and binding enforcement", () => {
  it("denies out-of-scope operations", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-scope-use");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    // A registration-scoped grant cannot create bonds.
    const agentId = await registerAgent(app, token, "ext-grant-scope-agent");
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${grantBearer(created)}`)
      .send({ agentId, commitmentMinorUnits: "100" });
    expect(bond.status).toBe(403);
  });

  it("enforces agent binding on bound grants", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-bind-use");
    const agentA = await registerAgent(app, token, "ext-grant-bind-a");
    const agentB = await registerAgent(app, token, "ext-grant-bind-b");
    const created = await createGrant(app, token, {
      scopes: ["bond:init"],
      agentId: agentA,
    });
    const wrongAgent = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${grantBearer(created)}`)
      .send({ agentId: agentB, commitmentMinorUnits: "100" });
    expect(wrongAgent.status).toBe(403);
  });

  it("denies grants on operator-only and agent-only routes", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-grant-escalate");
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const bearer = grantBearer(created);
    // Credential management is operator-only: a grant bearer is not an
    // operator session (and not an agent credential either), so it fails
    // at session/credential lookup with a generic 401.
    const agentId = await registerAgent(app, token, "ext-grant-esc-agent");
    const manage = await request(app)
      .get(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(manage.status).toBe(401);
    // Agent reads require agent principals, not grants.
    const read = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${bearer}`);
    expect(read.status).toBe(401);
  });

  it("prevents cross-operator grant use", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "op-grant-alice");
    const bob = await sessionFor(app, "op-grant-bob");
    const created = await createGrant(app, alice, {
      scopes: ["agent:register"],
    });
    // Bob cannot list or revoke Alice's grant.
    const list = await request(app)
      .get("/api/v1/setup-grants")
      .set("Authorization", `Bearer ${bob}`);
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { grantId: string }[]).some(
        (g) => g.grantId === created.metadata.grantId,
      ),
    ).toBe(false);
    const del = await request(app)
      .delete(`/api/v1/setup-grants/${created.metadata.grantId}`)
      .set("Authorization", `Bearer ${bob}`)
      .send({});
    expect(del.status).toBe(404);
  });
});

describe("D. credential lifecycle policy", () => {
  it("applies default expiry to new credentials", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-default");
    const agentId = await registerAgent(app, token, "ext-pol-default");
    const res = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(201);
    const expiresAt = Date.parse(res.body.data.metadata.expiresAt as string);
    expect(expiresAt).toBeGreaterThan(Date.now());
    // Default is ~90 days (bounded sanity window, not exact).
    expect(expiresAt - Date.now()).toBeGreaterThan(80 * 24 * 60 * 60 * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(
      91 * 24 * 60 * 60 * 1000,
    );
  });

  it("accepts explicit valid expiry and rejects excessive expiry", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-exp");
    const agentId = await registerAgent(app, token, "ext-pol-exp");
    const ok = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        expiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
    expect(ok.status).toBe(201);
    const tooFar = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        expiresAt: new Date(
          Date.now() + 400 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
    expect(tooFar.status).toBe(400);
  });

  it("enforces the active credential cap", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-cap");
    const agentId = await registerAgent(app, token, "ext-pol-cap");
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post(`/api/v1/agents/${agentId}/credentials`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(201);
    }
    const sixth = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(sixth.status).toBe(400);
    expect(sixth.body.code).toBe("INVALID_IDENTIFIER");
    // Revoking one frees a slot.
    const list = await request(app)
      .get(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`);
    const firstId = list.body.data[0].credentialId as string;
    const del = await request(app)
      .delete(`/api/v1/agents/${agentId}/credentials/${firstId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(del.status).toBe(200);
    const retry = await request(app)
      .post(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(retry.status).toBe(201);
  });

  it("rotation preserves behavior and old credential dies", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-rotate");
    const agentId = await registerAgent(app, token, "ext-pol-rotate");
    const created = await createAgentCredential(app, token, agentId);
    const rotated = await request(app)
      .post(
        `/api/v1/agents/${agentId}/credentials/${created.metadata.credentialId}/rotate`,
      )
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(rotated.status).toBe(201);
    const oldAttempt = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${credentialBearer(created)}`);
    expect(oldAttempt.status).toBe(401);
  });

  it("lists metadata without secrets", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-pol-list");
    const agentId = await registerAgent(app, token, "ext-pol-list");
    const created = await createAgentCredential(app, token, agentId);
    const res = await request(app)
      .get(`/api/v1/agents/${agentId}/credentials`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(created.secret);
    expect(res.body.data[0]).not.toHaveProperty("secret");
    expect(res.body.data[0]).not.toHaveProperty("secret_hash");
    expect(res.body.data[0]).toHaveProperty("credentialId");
    expect(res.body.data[0]).toHaveProperty("expiresAt");
  });
});

describe("E. audit, feed, and regression", () => {
  it("emits lifecycle events without secrets; bound-grant consumption surfaces in the operator feed", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-ev-grant");
    const agentId = await registerAgent(app, token, "ext-ev-grant");

    // Unbound grant lifecycle is recorded in protocol_events (agentId
    // NULL by construction: no agent exists yet at creation time).
    const created = await createGrant(app, token, {
      scopes: ["agent:register"],
    });
    const reg = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${grantBearer(created)}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "ext-ev-grant-fed",
      });
    expect(reg.status).toBe(201);
    const stored: { rows: { type: string; payload: unknown }[] } = await query(
      `SELECT type, payload FROM protocol_events
         WHERE payload->>'grantId' = $1 ORDER BY id`,
      [created.metadata.grantId],
    );
    const types = stored.rows.map((r) => r.type);
    expect(types).toContain("setup_grant.created");
    expect(types).toContain("setup_grant.consumed");
    expect(JSON.stringify(stored.rows)).not.toContain(created.secret);

    // A bound grant's consumed event carries the agent id, so it is
    // visible in the operator-scoped feed under the existing model.
    const bound = await createGrant(app, token, {
      scopes: ["bond:init"],
      agentId,
    });
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${grantBearer(bound)}`)
      .send({ agentId, commitmentMinorUnits: "100" });
    expect(bond.status).toBe(201);
    const feed = await request(app)
      .get("/api/v1/events?type=setup_grant.consumed")
      .set("Authorization", `Bearer ${token}`);
    expect(feed.status).toBe(200);
    const seen = (feed.body.data.events as { agentId: string | null }[]).some(
      (e) => e.agentId === agentId,
    );
    expect(seen).toBe(true);
    expect(JSON.stringify(feed.body.data)).not.toContain(bound.secret);
    expect(JSON.stringify(feed.body.data)).not.toContain(created.secret);
  });

  it("operator and attestor authentication still work", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-regress");
    const agentId = await registerAgent(app, token, "ext-regress");
    const read = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    const reg = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${token}`)
      .send({
        attestorId: "att-setup-reg-1",
        organization: "Org",
        secret: "0123456789abcdef",
      });
    expect(reg.status).toBe(201);
  });

  it("requireOperator rejects grant principals", async () => {
    const { requireOperator } = await import("./http/auth.js");
    const fakeReq = {
      auth: {
        operatorId: "op_x",
        sessionId: "",
        authMethod: "setup-grant",
        walletVerifyingKey: null,
        grant: { grantId: "grant_x", scopes: [], agentId: null },
      },
    } as never;
    let code: string | null = null;
    try {
      requireOperator(fakeReq);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        code = error.code;
      }
    }
    expect(code).toBe("FORBIDDEN");
  });
});
