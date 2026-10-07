/**
 * Phase 9.5 regression tests: rate limiting, proxy identity,
 * memory-store bounds, and abuse-path behavior.
 *
 * Deterministic: injected clocks for store/window tests; small
 * per-test policy overrides for HTTP tests (no sleeps).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { MemoryRateLimitStore } from "./http/rate-limit/store.js";
import { resolveRateLimitConfig } from "./http/rate-limit/policies.js";
import { clientIp } from "./http/rate-limit/identity.js";
import { rateLimitFor } from "./http/rate-limit/middleware.js";
import { resetRateLimiting } from "./http/rate-limit/registry.js";

beforeAll(async () => {
  await useIsolatedDb("ratelimit");
});

beforeEach(async () => {
  await resetDb();
  resetRateLimiting();
});

function testApp(env: Record<string, string> = {}): Express {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  const app = createApp();
  for (const key of Object.keys(env)) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  return app;
}

describe("A. basic rate limiting", () => {
  it("allows under the limit and returns 429 with headers at the limit", async () => {
    const app = testApp({
      RATE_LIMIT_PUBLIC_MAX: "2",
      RATE_LIMIT_PUBLIC_WINDOW_MS: "60000",
    });
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).get("/api/v1/public/agents/unknown-id");
      expect(res.headers["x-ratelimit-limit"]).toBe("2");
      expect(res.headers["x-ratelimit-remaining"]).toBe(String(1 - i));
    }
    const limited = await request(app).get("/api/v1/public/agents/unknown-id");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.body.requestId).toBeTruthy();
    expect(limited.headers["retry-after"]).toBeTruthy();
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(JSON.stringify(limited.body)).not.toContain("127.0.0.1");
  });
});

describe("B. window reset", () => {
  it("permits new requests after the window expires", () => {
    let now = 1_000_000;
    const store = new MemoryRateLimitStore();
    const policy = { name: "t", max: 1, windowMs: 1000 };
    expect(store.checkAndConsume("k", policy, now).allowed).toBe(true);
    expect(store.checkAndConsume("k", policy, now).allowed).toBe(false);
    now += 1001;
    const decision = store.checkAndConsume("k", policy, now);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(0);
  });
});

describe("C. identity isolation", () => {
  it("different operators do not share authenticated buckets", async () => {
    const app = testApp({
      RATE_LIMIT_MUTATION_MAX: "1",
      RATE_LIMIT_MUTATION_WINDOW_MS: "60000",
      DEV_AUTH_TOKEN: "test-dev-key",
    });
    process.env.DEV_AUTH_TOKEN = "test-dev-key";
    try {
      const alice = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "test-dev-key", externalKey: "alice-rl" });
      const bob = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "test-dev-key", externalKey: "bob-rl" });
      const first = await request(app)
        .post("/api/v1/agents")
        .set("Authorization", `Bearer ${alice.body.data.token}`)
        .send({
          platform: "p",
          agentType: "custom",
          capabilities: [],
          externalRef: "rl-a",
        });
      expect(first.status).toBe(201);
      const secondDenied = await request(app)
        .post("/api/v1/agents")
        .set("Authorization", `Bearer ${alice.body.data.token}`)
        .send({
          platform: "p",
          agentType: "custom",
          capabilities: [],
          externalRef: "rl-a2",
        });
      expect(secondDenied.status).toBe(429);
      // Bob has his own budget.
      const bobOk = await request(app)
        .post("/api/v1/agents")
        .set("Authorization", `Bearer ${bob.body.data.token}`)
        .send({
          platform: "p",
          agentType: "custom",
          capabilities: [],
          externalRef: "rl-b",
        });
      expect(bobOk.status).toBe(201);
    } finally {
      delete process.env.DEV_AUTH_TOKEN;
    }
  });

  it("auth attempts are keyed per credential target", async () => {
    const app = testApp({
      RATE_LIMIT_AUTH_MAX: "1",
      RATE_LIMIT_AUTH_WINDOW_MS: "60000",
      DEV_AUTH_TOKEN: "test-dev-key",
    });
    process.env.DEV_AUTH_TOKEN = "test-dev-key";
    try {
      const first = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "test-dev-key", externalKey: "target-a" });
      expect(first.status).toBe(201);
      const second = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "test-dev-key", externalKey: "target-a" });
      expect(second.status).toBe(429);
      // A different target gets its own budget.
      const other = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "test-dev-key", externalKey: "target-b" });
      expect(other.status).toBe(201);
    } finally {
      delete process.env.DEV_AUTH_TOKEN;
    }
  });
});

describe("D. authentication protection", () => {
  it("rate-limits failed authentication without revealing credential existence", async () => {
    const app = testApp({
      RATE_LIMIT_AUTH_MAX: "1",
      RATE_LIMIT_AUTH_WINDOW_MS: "60000",
      DEV_AUTH_TOKEN: "test-dev-key",
    });
    process.env.DEV_AUTH_TOKEN = "test-dev-key";
    try {
      const bad = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "wrong", externalKey: "victim" });
      expect(bad.status).toBe(401);
      const again = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "wrong", externalKey: "victim" });
      expect(again.status).toBe(429);
      expect(JSON.stringify(again.body)).not.toContain("test-dev-key");
    } finally {
      delete process.env.DEV_AUTH_TOKEN;
    }
  });
});

describe("E. public endpoints and health", () => {
  it("health and readiness stay usable under tight public limits", async () => {
    const app = testApp({
      RATE_LIMIT_PUBLIC_MAX: "1",
      RATE_LIMIT_PUBLIC_WINDOW_MS: "60000",
    });
    for (let i = 0; i < 5; i += 1) {
      const health = await request(app).get("/health");
      expect(health.status).toBe(200);
      const ready = await request(app).get("/ready");
      expect([200, 503]).toContain(ready.status);
    }
  });
});

describe("F. mutations and expensive operations", () => {
  it("applies stricter budgets to expensive and transaction routes", async () => {
    const app = testApp({
      RATE_LIMIT_EXPENSIVE_MAX: "1",
      RATE_LIMIT_EXPENSIVE_WINDOW_MS: "60000",
      RATE_LIMIT_TX_MAX: "1",
      RATE_LIMIT_TX_WINDOW_MS: "60000",
      DEV_AUTH_TOKEN: "test-dev-key",
    });
    process.env.DEV_AUTH_TOKEN = "test-dev-key";
    try {
      const sess = await request(app)
        .post("/api/v1/auth/session")
        .send({ devKey: "test-dev-key", externalKey: "op-exp" });
      const token = sess.body.data.token as string;
      const agent = await request(app)
        .post("/api/v1/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({
          platform: "p",
          agentType: "custom",
          capabilities: [],
          externalRef: "exp-1",
        });
      const agentId = agent.body.data.agentId as string;
      const one = await request(app)
        .post("/api/v1/risk/analyses")
        .set("Authorization", `Bearer ${token}`)
        .send({
          agentId,
          activity: { actionType: "transfer", action: "pay-vendor" },
        });
      expect([201, 400]).toContain(one.status);
      const two = await request(app)
        .post("/api/v1/risk/analyses")
        .set("Authorization", `Bearer ${token}`)
        .send({
          agentId,
          activity: { actionType: "transfer", action: "pay-vendor" },
        });
      expect(two.status).toBe(429);

      const tx1 = await request(app)
        .post("/api/v1/transactions")
        .set("Authorization", `Bearer ${token}`)
        .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "rl-tx-1" });
      expect([201, 400]).toContain(tx1.status);
      const tx2 = await request(app)
        .post("/api/v1/transactions")
        .set("Authorization", `Bearer ${token}`)
        .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "rl-tx-2" });
      expect(tx2.status).toBe(429);
    } finally {
      delete process.env.DEV_AUTH_TOKEN;
    }
  });
});

describe("G. proxy behavior", () => {
  it("ignores forwarded headers unless trust proxy is enabled", () => {
    const direct = {
      socket: { remoteAddress: "10.0.0.5" },
      headers: {},
      ip: "10.0.0.5",
    };
    const spoofed = {
      socket: { remoteAddress: "10.0.0.5" },
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.5" },
      ip: "10.0.0.5",
    };
    expect(clientIp(direct as never, { trustProxy: false })).toBe("10.0.0.5");
    // Untrusted: spoofed header ignored.
    expect(clientIp(spoofed as never, { trustProxy: false })).toBe("10.0.0.5");
    // Trusted: first forwarded address honored.
    expect(clientIp(spoofed as never, { trustProxy: true })).toBe("9.9.9.9");
    // Malformed header falls back to socket address.
    expect(
      clientIp(
        {
          socket: { remoteAddress: "10.0.0.5" },
          headers: { "x-forwarded-for": "!!!" },
          ip: "x",
        } as never,
        { trustProxy: true },
      ),
    ).toBe("10.0.0.5");
  });

  it("rejects invalid TRUST_PROXY configuration", async () => {
    expect(() =>
      resolveRateLimitConfig({ TRUST_PROXY: "sometimes" } as NodeJS.ProcessEnv),
    ).toThrowError(/TRUST_PROXY/);
    expect(resolveRateLimitConfig({} as NodeJS.ProcessEnv).trustProxy).toBe(
      false,
    );
  });
});

describe("H. memory safety", () => {
  it("bounds buckets and cleans expired entries deterministically", () => {
    const store = new MemoryRateLimitStore(3);
    const policy = { name: "t", max: 100, windowMs: 1000 };
    store.checkAndConsume("a", policy, 0);
    store.checkAndConsume("b", policy, 0);
    store.checkAndConsume("c", policy, 0);
    expect(store.size()).toBe(3);
    // Fourth key forces eviction of the oldest; size stays bounded.
    store.checkAndConsume("d", policy, 0);
    expect(store.size()).toBe(3);
    expect(store.size()).toBeLessThanOrEqual(3);
    // After windows pass, prune reclaims everything.
    expect(store.prune(25 * 60 * 60 * 1000)).toBe(3);
    expect(store.size()).toBe(0);
  });

  it("rejects invalid store and policy configuration", async () => {
    expect(() => new MemoryRateLimitStore(0)).toThrowError(/maxKeys/);
    expect(() =>
      resolveRateLimitConfig({
        RATE_LIMIT_AUTH_MAX: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/RATE_LIMIT_AUTH_MAX/);
    expect(() =>
      resolveRateLimitConfig({
        RATE_LIMIT_READ_WINDOW_MS: "50",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/RATE_LIMIT_READ_WINDOW_MS/);
    expect(() =>
      resolveRateLimitConfig({
        RATE_LIMIT_TX_MAX: "2000000",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/RATE_LIMIT_TX_MAX/);
  });
});

describe("I. middleware contract", () => {
  it("rate-limit rejections carry request ids and preserve security headers", async () => {
    const app = testApp({
      RATE_LIMIT_PUBLIC_MAX: "1",
      RATE_LIMIT_PUBLIC_WINDOW_MS: "60000",
    });
    await request(app).get("/api/v1/public/agents/nope");
    const limited = await request(app).get("/api/v1/public/agents/nope");
    expect(limited.status).toBe(429);
    expect(limited.body.requestId).toBeTruthy();
    expect(limited.headers["x-content-type-options"]).toBe("nosniff");
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("per-route middleware passes through when disabled", async () => {
    let nextCalled = false;
    rateLimitFor("mutation", undefined, {
      store: new MemoryRateLimitStore(),
      config: { ...resolveRateLimitConfig(), enabled: false },
    })(
      { auth: { operatorId: "op-1" }, headers: {} } as never,
      { setHeader: () => {} } as never,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("global middleware classifies methods and paths correctly", async () => {
    const { classifyRequest } = await import("./http/rate-limit/policies.js");
    expect(classifyRequest("OPTIONS", "/api/v1/agents")).toBeNull();
    expect(classifyRequest("GET", "/health")).toBeNull();
    expect(classifyRequest("GET", "/ready")).toBeNull();
    expect(classifyRequest("POST", "/api/v1/auth/session")).toBe("auth");
    expect(classifyRequest("GET", "/api/v1/public/agents/x")).toBe("public");
    expect(classifyRequest("GET", "/api/v1/public/agents/x/eligibility")).toBe(
      "publicEligibility",
    );
    expect(classifyRequest("GET", "/api/v1/agents")).toBe("read");
    expect(classifyRequest("POST", "/api/v1/agents")).toBeNull();
    expect(classifyRequest("POST", "/api/v1/risk/analyses")).toBeNull();
  });
});
