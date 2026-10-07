/**
 * Phase 24 model-usage integration tests.
 *
 * Proves adapter-shaped model activities (provider/model/tokens as
 * built by the SDK provider adapters) flow through the unchanged
 * pipeline: Phase 22 policy evaluation -> risk flags -> ledger
 * persistence -> reputation observation, with delegation
 * attribution preserved. No provider calls anywhere.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";

beforeAll(async () => {
  await useIsolatedDb("modelusage");
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

function modelActivity(id: string, usage: Record<string, unknown>) {
  return {
    activityId: id,
    occurredAt: "2026-10-07T12:00:00.000Z",
    actionType: "tool-call",
    action: "model-invocation",
    policyContext: {
      policyVersion: "bond-policy-v1",
      allowedActions: ["model-invocation"],
    },
    ...usage,
  };
}

describe("model usage end to end", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("allowed provider/model with bounded usage analyzes cleanly", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-mu-clean");
    const agentId = await registerAgent(app, token, "ext-mu-clean");
    await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: {
          allowedProviders: ["openai"],
          allowedModels: ["gpt-4o"],
          maxInputTokens: 100000,
        },
      })
      .expect(201);
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        activity: modelActivity("act-mu-1", {
          provider: "openai",
          model: "gpt-4o",
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        }),
      });
    expect(res.status).toBe(201);
    expect(res.body.data.flagIds).toEqual([]);
    expect(res.body.data.policy.allowed).toBe(true);
    const ledger: { rows: Record<string, unknown>[] } = await query(
      `SELECT provider, model, input_tokens, total_tokens
       FROM agent_activity_ledger WHERE analysis_id = $1`,
      [res.body.data.analysisId],
    );
    expect(ledger.rows[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      input_tokens: "10",
      total_tokens: "30",
    });
  });

  it("forbidden model and token overuse become policy violations and flags", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-mu-deny");
    const agentId = await registerAgent(app, token, "ext-mu-deny");
    await request(app)
      .post(`/api/v1/agents/${agentId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        policy: {
          allowedProviders: ["openai"],
          allowedModels: ["gpt-4o"],
          maxInputTokens: 100000,
        },
      })
      .expect(201);
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId,
        activity: modelActivity("act-mu-2", {
          provider: "deepseek",
          model: "deepseek-chat",
          inputTokens: 150000,
          outputTokens: 1000,
          totalTokens: 151000,
        }),
      });
    expect(res.status).toBe(201);
    const ruleIds = (
      res.body.data.policy.violations as { ruleId: string }[]
    ).map((v) => v.ruleId);
    expect(ruleIds).toContain("policy-provider-denied");
    expect(ruleIds).toContain("policy-model-denied");
    expect(ruleIds).toContain("policy-input-token-limit");
    expect(res.body.data.policy.allowed).toBe(false);
    expect(res.body.data.flagIds.length).toBeGreaterThan(0);
    // Observed risk debits executor reputation via the existing hook.
    const rep = await request(app)
      .get(`/api/v1/agents/${agentId}/reputation`)
      .set("Authorization", `Bearer ${token}`);
    expect(rep.body.data.score).toBeLessThan(75);
  });

  it("delegated model activity retains attribution end to end", async () => {
    const app = createApp();
    const token = await sessionFor(app, "op-mu-dlg");
    const agentA = await registerAgent(app, token, "ext-mu-dlga");
    const agentB = await registerAgent(app, token, "ext-mu-dlgb");
    await request(app)
      .post(`/api/v1/agents/${agentA}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["activity:submit"] });
    const credBRes = await request(app)
      .post(`/api/v1/agents/${agentB}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["agent:read"] });
    expect(credBRes.status).toBe(201);
    const credB = `${credBRes.body.data.metadata.credentialId as string}.${credBRes.body.data.secret as string}`;
    const dlg = await request(app)
      .post(`/api/v1/agents/${agentA}/delegations`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        delegateAgentId: agentB,
        capabilities: ["activity:submit"],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    expect(dlg.status).toBe(201);
    const delegationId = dlg.body.data.delegationId as string;
    // B authenticates with its own credential (agent:read only —
    // no activity:submit) and submits a model call under A's
    // delegation. The server derives requester=A, executor=B.
    const res = await request(app)
      .post("/api/v1/risk/analyses")
      .set("Authorization", `Bearer ${credB}`)
      .send({
        agentId: agentB,
        delegationId,
        activity: modelActivity("act-mu-dlg-1", {
          provider: "gemini",
          model: "gemini-2.0-flash",
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
        }),
      });
    expect(res.status).toBe(201);
    expect(res.body.data.attribution).toEqual({
      requesterAgentId: agentA,
      executorAgentId: agentB,
      delegationId,
    });
    const ledger: { rows: Record<string, unknown>[] } = await query(
      `SELECT agent_id, requester_agent_id, delegation_id, provider
       FROM agent_activity_ledger WHERE analysis_id = $1`,
      [res.body.data.analysisId],
    );
    expect(ledger.rows[0]).toMatchObject({
      agent_id: agentB,
      requester_agent_id: agentA,
      delegation_id: delegationId,
      provider: "gemini",
    });
  });
});
