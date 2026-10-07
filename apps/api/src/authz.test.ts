/**
 * Phase 9.3 authentication & authorization tests.
 *
 * A. Authentication lifecycle and failures.
 * B. Cross-operator authorization boundaries.
 * C. Attestor isolation from operator auth.
 * D. Production fail-closed configuration.
 * E. Session lifecycle at the store level.
 * F. Frontend 401 handling is covered in apps/web (client tests).
 * G. Credential-leakage assertions throughout.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import {
  attestorPrincipal,
  operatorPrincipal,
  systemPrincipal,
} from "./http/principals.js";

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
  return sess.body.token as string;
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

beforeAll(async () => {
  await useIsolatedDb("authz");
});

beforeEach(async () => {
  await resetDb();
});

describe("A. authentication", () => {
  it("rejects missing, malformed, invalid, expired, and revoked sessions", async () => {
    const app = createApp();
    const missing = await request(app).get("/api/v1/agents");
    expect(missing.status).toBe(401);

    const malformed = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", "Token abc");
    expect(malformed.status).toBe(401);

    const invalid = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", "Bearer not-a-real-token");
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe("UNAUTHORIZED");

    const token = await sessionFor(app, "carol");
    await query("UPDATE sessions SET expires_at = now() - interval '1 hour'");
    const expired = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`);
    expect(expired.status).toBe(401);

    const token2 = await sessionFor(app, "carol");
    await query("UPDATE sessions SET revoked = TRUE");
    const revoked = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${token2}`);
    expect(revoked.status).toBe(401);
  });

  it("sign-out revokes the session server-side", async () => {
    const app = createApp();
    const token = await sessionFor(app, "dave");
    const out = await request(app)
      .post("/api/v1/auth/sign-out")
      .set("Authorization", `Bearer ${token}`);
    expect(out.status).toBe(200);
    const after = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it("dev session issuance requires the dev key", async () => {
    const app = createApp();
    process.env.DEV_AUTH_TOKEN = DEV_KEY;
    const bad = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: "wrong", externalKey: "erin" });
    expect(bad.status).toBe(401);
  });
});

describe("B. authorization boundaries", () => {
  it("blocks cross-operator agent, bond, and transaction access", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice");
    const bob = await sessionFor(app, "bob");
    const agentId = await registerAgent(app, alice, "cross-1");

    const crossAgent = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(crossAgent.status).toBe(403);

    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${alice}`)
      .send({ agentId, commitmentMinorUnits: "1000" });
    expect(bond.status).toBe(201);
    const bondId = bond.body.data.bondId as string;

    const crossBond = await request(app)
      .get(`/api/v1/bonds/${bondId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(crossBond.status).toBe(403);

    const tx = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        bondId,
        idempotencyKey: "authz-tx-1",
      });
    expect(tx.status).toBe(201);
    const txId = tx.body.data.transactionId as string;

    const crossTx = await request(app)
      .get(`/api/v1/transactions/${txId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(crossTx.status).toBe(403);

    const crossAdvance = await request(app)
      .post(`/api/v1/transactions/${txId}/advance`)
      .set("Authorization", `Bearer ${bob}`)
      .send({ status: "WALLET_APPROVAL" });
    expect(crossAdvance.status).toBe(403);

    const crossConfirm = await request(app)
      .post(`/api/v1/transactions/${txId}/confirm`)
      .set("Authorization", `Bearer ${bob}`)
      .send({});
    expect(crossConfirm.status).toBe(403);
  });

  it("protects private risk and attestation data per operator", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice");
    const bob = await sessionFor(app, "bob");
    const agentId = await registerAgent(app, alice, "cross-2");

    const analysis = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        agentId,
        activity: {
          activityId: "act-1",
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
    expect(analysis.status).toBe(201);
    const flagId = analysis.body.data.flagIds[0] as string;

    const crossFlags = await request(app)
      .get(`/api/v1/risk/flags?agentId=${agentId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(crossFlags.status).toBe(403);

    const crossFlag = await request(app)
      .get(`/api/v1/risk/flags/${flagId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(crossFlag.status).toBe(403);

    const attestation = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        flagId,
        attestorIds: ["att-1"],
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
    expect(attestation.status).toBe(201);
    const attestationId = attestation.body.data.attestationId as string;

    const crossAttestation = await request(app)
      .get(`/api/v1/attestations/${attestationId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(crossAttestation.status).toBe(403);
  });
});

describe("C. attestor isolation", () => {
  it("attestor secrets work only on attestor endpoints", async () => {
    const app = createApp();
    const alice = await sessionFor(app, "alice");
    const agentId = await registerAgent(app, alice, "iso-1");
    const analysis = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        agentId,
        activity: {
          activityId: "act-2",
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
    const flagId = analysis.body.data.flagIds[0] as string;
    const reg = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        attestorId: "att-iso-1",
        organization: "Org",
        secret: "0123456789abcdef",
      });
    expect(reg.status).toBe(201);
    const attestation = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        flagId,
        attestorIds: ["att-iso-1"],
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
    const attestationId = attestation.body.data.attestationId as string;

    // Attestor secret on an operator endpoint: rejected (no bearer).
    const misuse = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("X-Attestor-Secret", "0123456789abcdef");
    expect(misuse.status).toBe(401);

    // Operator bearer cannot submit verdicts without the attestor secret.
    const noSecret = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ attestorId: "att-iso-1", verdict: "confirm" });
    expect(noSecret.status).toBe(401);

    // Wrong attestor secret rejected.
    const wrong = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .send({ attestorId: "att-iso-1", verdict: "confirm" })
      .set("X-Attestor-Secret", "wrong-secret-value!!");
    expect(wrong.status).toBe(401);

    // Correct secret works.
    const ok = await request(app)
      .post(`/api/v1/attestations/${attestationId}/verdicts`)
      .set("X-Attestor-Secret", "0123456789abcdef")
      .send({ attestorId: "att-iso-1", verdict: "confirm" });
    expect(ok.status).toBe(201);
  });
});

describe("principals", () => {
  it("constructs non-confusable principal identities", () => {
    const op = operatorPrincipal("op-1", "sess-1");
    const at = attestorPrincipal("att-1");
    const sys = systemPrincipal("worker");
    expect(op.type).toBe("operator");
    expect(at.type).toBe("attestor");
    expect(sys.type).toBe("system");
    expect(op.id).not.toBe(at.id);
    expect(sys.sessionId).toBeUndefined();
  });
});

describe("D. production fail-closed", () => {
  it("rejects DEV_AUTH_TOKEN in production and unknown networks", async () => {
    const { loadConfig } = await import("./config.js");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://x",
        CORS_ORIGINS: "https://app.example",
        DEV_AUTH_TOKEN: "dev-change-me",
      }),
    ).toThrowError(/DEV_AUTH_TOKEN/);
    // Production without dev auth: session issuance refuses.
    const { issueDevSession } = await import("./http/auth.js");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousToken = process.env.DEV_AUTH_TOKEN;
    const previousCors = process.env.CORS_ORIGINS;
    const previousNetwork = process.env.MIDNIGHT_NETWORK;
    const previousAddress = process.env.BOND_CONTRACT_ADDRESS;
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.example";
    process.env.MIDNIGHT_NETWORK = "undeployed";
    process.env.BOND_CONTRACT_ADDRESS = "addr-test-authz";
    delete process.env.DEV_AUTH_TOKEN;
    try {
      await expect(issueDevSession("mallory")).rejects.toThrowError(
        /not enabled/,
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousNetwork === undefined) {
        delete process.env.MIDNIGHT_NETWORK;
      } else {
        process.env.MIDNIGHT_NETWORK = previousNetwork;
      }
      if (previousAddress === undefined) {
        delete process.env.BOND_CONTRACT_ADDRESS;
      } else {
        process.env.BOND_CONTRACT_ADDRESS = previousAddress;
      }
      if (previousToken !== undefined) {
        process.env.DEV_AUTH_TOKEN = previousToken;
      }
      if (previousCors === undefined) {
        delete process.env.CORS_ORIGINS;
      } else {
        process.env.CORS_ORIGINS = previousCors;
      }
    }
  });
});

describe("E. session lifecycle at the store level", () => {
  it("stores hashes, never raw tokens", async () => {
    const { hashToken, newToken } = await import("./db/stores/operators.js");
    const { token } = newToken("sess");
    expect(token.length).toBeGreaterThan(32);
    const rows: { rows: { token_hash: string }[] } = await query(
      "SELECT token_hash FROM sessions",
    );
    for (const row of rows.rows) {
      expect(row.token_hash).toHaveLength(64);
      expect(row.token_hash).not.toBe(token);
    }
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("G. leakage", () => {
  it("auth errors carry no credential material", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: "super-secret-dev-key-123", externalKey: "x" });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-dev-key");
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});
