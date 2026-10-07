/**
 * Metrics endpoint tests (Phase 15): truthful Prometheus output,
 * bounded labels, and privacy (no tokens, secrets, URLs, or IDs).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { resetMetrics } from "./http/metrics.js";

beforeAll(async () => {
  await useIsolatedDb("metrics");
});

beforeEach(async () => {
  await resetDb();
  resetMetrics();
});

describe("GET /metrics", () => {
  it("serves Prometheus text with core metric families", async () => {
    const app = createApp();
    await request(app).get("/health");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("bond_http_requests_total");
    expect(res.text).toContain("bond_http_request_duration_seconds_bucket");
    expect(res.text).toContain("bond_worker_polls_total");
    expect(res.text).toContain("bond_process_uptime_seconds");
    // The /health hit is counted under its route template.
    expect(res.text).toMatch(/route="\/health"/);
  });

  it("collapses unknown paths into a single unmatched bucket", async () => {
    const app = createApp();
    await request(app).get("/nope-abc-123");
    await request(app).get("/totally-different-path-xyz");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    // Raw request paths must never appear as label values.
    expect(res.text).not.toContain("nope-abc-123");
    expect(res.text).not.toContain("totally-different-path-xyz");
    expect(res.text).toMatch(/route="unmatched"/);
  });

  it("never exposes tokens, secrets, or request bodies", async () => {
    const app = createApp();
    const secretToken = "Bearer sess_secret-token-xyz-123";
    await request(app).get("/api/v1/agents").set("Authorization", secretToken);
    await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: "wrong-dev-key", externalKey: "victim" });
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("sess_secret-token-xyz-123");
    expect(res.text).not.toContain("wrong-dev-key");
    expect(res.text).not.toContain("victim");
  });

  it("counts status classes without inventing values", async () => {
    const app = createApp();
    await request(app).get("/health");
    await request(app).get("/definitely-not-here");
    const res = await request(app).get("/metrics");
    expect(res.text).toMatch(/status_class="2xx"/);
    expect(res.text).toMatch(/status_class="4xx"/);
  });
});
