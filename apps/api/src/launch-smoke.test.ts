/**
 * Phase 28 production launch smoke test (release gate).
 *
 * One deterministic end-to-end pass through the complete agent
 * lifecycle on SIMULATED execution: health → database →
 * authentication → authorization → registration → public
 * verification → eligibility → risk assessment → attestation →
 * bond lifecycle → worker processing → transaction status →
 * error handling → audit trail. No network, no wallet, no chain.
 *
 * Midnight-dependent REAL steps are explicitly out of scope here:
 * they require the Phase 25 wallet ceremony (blocked externally).
 * Nothing in this file presents SIMULATED execution as REAL.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";
import { runTransactionWorkerOnce } from "./services/transactions.js";

beforeAll(async () => {
  await useIsolatedDb("launchsmoke");
});

const DEV_KEY = "test-dev-key";
const ATTESTOR_SECRET = "attestor-secret-0123456789";

describe("launch smoke: full lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("passes every stage with audit trail intact", async () => {
    const app = createApp();

    // 1. API health (no dependencies).
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: "ok",
      service: "bond-api",
    });

    // 2-3. Authentication + authorization (wrong key rejected).
    const badAuth = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: "wrong-key", externalKey: "op-smoke" });
    expect(badAuth.status).toBe(401);
    process.env.DEV_AUTH_TOKEN = DEV_KEY;
    const sess = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: DEV_KEY, externalKey: "op-smoke" });
    expect(sess.status).toBe(201);
    const token = sess.body.data.token as string;

    // 4. Agent registration.
    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "smoke-agent-1",
      });
    expect(agent.status).toBe(201);
    const agentId = agent.body.data.agentId as string;

    // 5. Public verification exposes only public data.
    const pub = await request(app).get(`/api/v1/public/agents/${agentId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.verification).toBeTruthy();
    expect(JSON.stringify(pub.body.data)).not.toContain("commitment");

    // 6. Bond lifecycle: create + fund through the worker.
    const bond = await request(app)
      .post("/api/v1/bonds")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId, commitmentMinorUnits: "10000" });
    expect(bond.status).toBe(201);
    const bondId = bond.body.data.bondId as string;
    const fund = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        bondId,
        idempotencyKey: "smoke-fund",
      });
    const fundId = fund.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${fundId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    const handle = connectMidnight(resolveMidnightConfig({}));
    expect(handle.mode).toBe("SIMULATED");
    await runTransactionWorkerOnce(handle);
    await request(app)
      .post(`/api/v1/transactions/${fundId}/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    const funded = await request(app)
      .get(`/api/v1/transactions/${fundId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(funded.body.data.status).toBe("CONFIRMED");

    // 7. Eligibility request (SIMULATED fixture kind).
    const proof = await request(app)
      .post("/api/v1/eligibility/proofs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        bondId,
        requiredMinimumMinorUnits: "1000",
        nonce: "smoke-nonce-1",
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    expect(proof.status).toBe(201);

    // 8. Risk assessment produces a flag.
    const analyzed = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        activity: {
          activityId: "act-smoke-1",
          occurredAt: "2026-10-06T10:00:00.000Z",
          actionType: "transfer",
          action: "pay-vendor",
          amountMinorUnits: "9000",
          policyContext: {
            policyVersion: "bond-policy-v1",
            allowedActions: ["pay-vendor"],
            spendLimitMinorUnits: "100",
          },
        },
      });
    expect(analyzed.status).toBe(201);
    expect(analyzed.body.data.flagIds.length).toBeGreaterThan(0);
    const flagId = analyzed.body.data.flagIds[0] as string;

    // 9. Attestation: register attestor, request, confirm, decide.
    const attestor = await request(app)
      .post("/api/v1/attestors")
      .set("Authorization", `Bearer ${token}`)
      .send({ organization: "Smoke Org", secret: ATTESTOR_SECRET });
    const attestorId = attestor.body.data.attestorId as string;
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

    // 10. Enforcement through worker + confirm, bond slashed.
    const enforce = await request(app)
      .post(`/api/v1/attestations/${attestationId}/enforce`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountMinorUnits: "1000", idempotencyKey: "smoke-enforce" });
    expect(enforce.status).toBe(201);
    const txId = enforce.body.data.transactionId as string;
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }
    await runTransactionWorkerOnce(handle);
    const submitted = await request(app)
      .get(`/api/v1/transactions/${txId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(submitted.body.data.status).toBe("SUBMITTED");
    expect(submitted.body.data.chainTxId?.startsWith("sim-")).toBe(true);
    await request(app)
      .post(`/api/v1/transactions/${txId}/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    const bondAfter = await request(app)
      .get(`/api/v1/bonds/${bondId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(bondAfter.body.data.status).toBe("PARTIALLY_SLASHED");

    // 11. Error handling stays structured everywhere touched.
    const missing = await request(app)
      .get("/api/v1/agents/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
    expect(Object.keys(missing.body).sort()).toEqual([
      "code",
      "message",
      "requestId",
    ]);

    // 12. Audit trail: every stage emitted protocol events.
    const events: { rows: { type: string }[] } = await query(
      "SELECT DISTINCT type FROM protocol_events WHERE agent_id = $1",
      [agentId],
    );
    const types = events.rows.map((r) => r.type);
    for (const expected of [
      "AGENT_REGISTERED",
      "BOND_CREATED",
      "RISK_FLAG_RAISED",
      "ATTESTATION_ISSUED",
      "DECISION_ISSUED",
      "TRANSACTION_STATUS_CHANGED",
    ]) {
      expect(types).toContain(expected);
    }
  });
});
