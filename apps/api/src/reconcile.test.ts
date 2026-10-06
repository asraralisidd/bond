import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { runReconciliationOnce } from "./services/reconcile.js";
import { query } from "./db/pool.js";

beforeAll(async () => {
  await useIsolatedDb("reconcile");
});

const DEV_KEY = "test-dev-key";

describe("reconciliation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("heals divergent mirrors with chain-wins and records divergence", async () => {
    const app = createApp();
    process.env.DEV_AUTH_TOKEN = DEV_KEY;
    const sess = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: DEV_KEY, externalKey: "ivan" });
    const token = sess.body.token as string;
    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "custom",
        agentType: "custom",
        capabilities: [],
        externalRef: "recon-agent-1",
      });
    const agentId = agent.body.data.agentId as string;
    // Simulate drift: DB says ACTIVE while nothing exists on chain.
    await query("UPDATE agents SET status = 'ACTIVE' WHERE id = $1", [agentId]);
    const handle = connectMidnight(resolveMidnightConfig({}));
    const report = await runReconciliationOnce(handle, "contract-test-addr");
    expect(report.checked).toBe(1);
    // Absent from the SIMULATED chain ledger → no observation, no conflict.
    expect(report.conflicts).toBe(0);

    // Seed the SIMULATED chain ledger independently, then drift the DB.
    const { registerAgentOp } = await import("@bond/midnight-adapter");
    registerAgentOp(handle, {
      kind: "register-agent",
      agentId,
      operatorId: "op-seed",
    });
    await query("UPDATE agents SET status = 'SLASHED' WHERE id = $1", [
      agentId,
    ]);
    const report2 = await runReconciliationOnce(handle, "contract-test-addr");
    expect(report2.conflicts).toBe(1);
    expect(report2.healed).toBe(1);
    const events: { rows: { type: string }[] } = await query(
      "SELECT type FROM protocol_events WHERE agent_id = $1",
      [agentId],
    );
    expect(events.rows.map((r) => r.type)).toContain(
      "CHAIN_DIVERGENCE_DETECTED",
    );
    const healed = await query("SELECT status FROM agents WHERE id = $1", [
      agentId,
    ]);
    expect(healed.rows[0]?.status).toBe("REGISTERED");
  });
});
