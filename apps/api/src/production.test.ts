/**
 * Phase 9.1 regression tests: production hardening behavior.
 * Covers JSON 404s, security headers, CORS, body limits, timeouts,
 * /health vs /ready, graceful shutdown, error sanitization, and
 * production configuration validation. Existing Phase 0–8 tests are
 * untouched.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import { createApp } from "./index.js";
import { loadConfig } from "./config.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { timeoutMiddleware } from "./http/middleware/timeout.js";
import {
  createShutdownController,
  installProcessHandlers,
} from "./shutdown.js";
import { DomainError } from "@bond/shared-types";
import { MidnightError } from "@bond/midnight-adapter";

beforeAll(async () => {
  await useIsolatedDb("production");
});

beforeEach(async () => {
  await resetDb();
});

describe("JSON 404 handler", () => {
  it("returns JSON (never HTML) for unknown GET, POST, and API paths", async () => {
    const app = createApp();
    const getRes = await request(app).get("/nope");
    expect(getRes.status).toBe(404);
    expect(getRes.headers["content-type"]).toMatch(/json/);
    expect(getRes.body.code).toBe("NOT_FOUND");
    expect(getRes.body.requestId).toBeTruthy();

    const apiRes = await request(app).get("/api/v1/definitely-not-here");
    expect(apiRes.status).toBe(404);
    expect(apiRes.body.code).toBe("NOT_FOUND");

    const postRes = await request(app).post("/api/v1/missing").send({});
    expect(postRes.status).toBe(404);
    expect(postRes.body.code).toBe("NOT_FOUND");
  });
});

describe("security headers", () => {
  it("sets baseline headers without breaking JSON responses", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["x-frame-options"]).toBeTruthy();
    expect(res.body.status).toBe("ok");
  });
});

describe("CORS configuration", () => {
  it("allows the configured origin and rejects others as JSON", async () => {
    const app = createApp();
    const allowed = await request(app)
      .get("/health")
      .set("Origin", "http://localhost:5173");
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
    const denied = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example");
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
  });

  it("fails fast on invalid production CORS configuration", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://x",
        MIDNIGHT_NETWORK: "undeployed",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/CORS_ORIGINS/);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://x",
        MIDNIGHT_NETWORK: "undeployed",
        CORS_ORIGINS: "https://a.example, *",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/\*/);
    const ok = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://x",
      MIDNIGHT_NETWORK: "undeployed",
      CORS_ORIGINS: "https://a.example, https://b.example",
    } as NodeJS.ProcessEnv);
    expect(ok.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("rejects dev auth and bad values in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://x",
        MIDNIGHT_NETWORK: "undeployed",
        CORS_ORIGINS: "https://a.example",
        DEV_AUTH_TOKEN: "dev-change-me",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/DEV_AUTH_TOKEN/);
    // Phase 11: production without an explicit Midnight network fails
    // closed (empty would silently mean SIMULATED).
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://x",
        CORS_ORIGINS: "https://a.example",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/MIDNIGHT_NETWORK/);
    const explicit = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://x",
      CORS_ORIGINS: "https://a.example",
      MIDNIGHT_NETWORK: "undeployed",
    } as NodeJS.ProcessEnv);
    expect(explicit.midnightNetwork).toBe("undeployed");
    expect(() =>
      loadConfig({ NODE_ENV: "nope" } as NodeJS.ProcessEnv),
    ).toThrowError(/NODE_ENV/);
    expect(() =>
      loadConfig({ BODY_LIMIT: "huge" } as NodeJS.ProcessEnv),
    ).toThrowError(/BODY_LIMIT/);
    expect(() =>
      loadConfig({ BODY_LIMIT: "100mb" } as NodeJS.ProcessEnv),
    ).toThrowError(/BODY_LIMIT/);
  });
});

describe("body limits", () => {
  it("rejects oversized JSON cleanly as JSON", async () => {
    const app = createApp();
    const big = "x".repeat(200 * 1024);
    const res = await request(app)
      .post("/api/v1/agents")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ platform: big }));
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.code).toBe("BODY_TOO_LARGE");
  });
});

describe("request timeout middleware", () => {
  it("returns structured 503 with request id and clears timers", async () => {
    const findings: { status?: number; body?: unknown } = {};
    let finished: (() => void)[] = [];
    const res = {
      headersSent: false,
      status(code: number) {
        findings.status = code;
        return this;
      },
      json(body: unknown) {
        findings.body = body;
        return this;
      },
      on(event: string, cb: () => void) {
        if (event === "finish" || event === "close") {
          finished.push(cb);
        }
        return this;
      },
    } as unknown as Response;
    const req = {
      headers: { "x-request-id": "req-timeout-1" },
    } as unknown as Request;
    vi.useFakeTimers();
    try {
      const next = vi.fn();
      const middleware = timeoutMiddleware(100);
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(findings.status).toBe(503);
      expect(findings.body).toMatchObject({
        code: "REQUEST_TIMEOUT",
        requestId: "req-timeout-1",
      });
      finished = [];
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire after the response finished", async () => {
    const json = vi.fn();
    const res = {
      headersSent: true,
      status: vi.fn().mockReturnThis(),
      json,
      on: vi.fn(),
    } as unknown as Response;
    const req = { headers: {} } as unknown as Request;
    vi.useFakeTimers();
    try {
      const middleware = timeoutMiddleware(10);
      middleware(req, res, vi.fn());
      await vi.advanceTimersByTimeAsync(50);
      expect(json).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/health vs /ready", () => {
  it("reports liveness without dependencies", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "bond-api" });
  });

  it("reports ready when DB and schema are present", async () => {
    const app = createApp();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.database).toMatchObject({ ok: true, schema: true });
    expect(res.body.checks.midnight.mode).toBe("SIMULATED");
    expect(JSON.stringify(res.body)).not.toContain("5544");
    expect(JSON.stringify(res.body)).not.toContain("bond");
  });

  it("reports 503 when the database is unreachable", async () => {
    const { checkReadiness } = await import("./http/routes/system.js");
    const result = await checkReadiness(
      "postgresql://bond:bond@127.0.0.1:59999/bond_nope",
      "simulated",
    );
    expect(result.ready).toBe(false);
    expect(result.checks.database.ok).toBe(false);
  });

  it("reports not-ready when schema is missing and never claims REAL", async () => {
    const { checkReadiness } = await import("./http/routes/system.js");
    const { Pool } = await import("pg");
    const admin = new Pool({
      connectionString:
        process.env.TEST_ADMIN_DATABASE_URL ??
        "postgresql://bond:bond@localhost:5544/bond_dev",
    });
    try {
      await admin.query("DROP DATABASE IF EXISTS bond_test_noschema");
      await admin.query('CREATE DATABASE "bond_test_noschema"');
    } finally {
      await admin.end();
    }
    const result = await checkReadiness(
      "postgresql://bond:bond@localhost:5544/bond_test_noschema",
      "simulated",
    );
    expect(result.ready).toBe(false);
    expect(result.checks.database).toMatchObject({ ok: true, schema: false });
    expect(result.checks.midnight.mode).toBe("SIMULATED");
  });
});

describe("graceful shutdown", () => {
  it("drains, closes pool, and exits 0 exactly once", async () => {
    const events: string[] = [];
    let exited: number | null = null;
    const controller = createShutdownController({
      closeServer: async () => {
        events.push("server");
      },
      closePool: async () => {
        events.push("pool");
      },
      shutdownTimeoutMs: 5000,
      onLog: (message: string) => events.push(`log:${message}`),
      exit: (code: number) => {
        exited = code;
      },
    });
    await controller.shutdown("SIGTERM");
    expect(events).toContain("server");
    expect(events).toContain("pool");
    expect(exited).toBe(0);
    await controller.shutdown("SIGTERM");
    expect(exited).toBe(0);
  });

  it("forces exit when a second signal arrives mid-drain", async () => {
    let exited: number | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createShutdownController({
      closeServer: () => gate,
      closePool: async () => {},
      shutdownTimeoutMs: 50,
      onLog: () => {},
      exit: (code: number) => {
        exited = code;
      },
    });
    const first = controller.shutdown("SIGTERM");
    await Promise.resolve();
    await controller.shutdown("SIGINT");
    expect(exited).toBe(1);
    release();
    await first;
  });

  it("installs process handlers without killing the test runner", () => {
    const added: string[] = [];
    const fake = {
      on: (event: string, _cb: (...args: never[]) => void) => {
        added.push(event);
        return fake;
      },
    };
    installProcessHandlers(
      fake as unknown as NodeJS.Process,
      async () => {},
      () => {},
    );
    expect(added).toEqual(
      expect.arrayContaining([
        "SIGTERM",
        "SIGINT",
        "uncaughtException",
        "unhandledRejection",
      ]),
    );
  });
});

describe("error sanitization", () => {
  it("preserves known domain errors and sanitizes the rest", async () => {
    const app = createApp();
    const known = await request(app).get("/api/v1/agents/does-not-exist");
    expect(known.status).toBe(401);

    const { errorHandler } = await import("./http/errors.js");
    const capture: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        capture.status = code;
        return this;
      },
      json(body: unknown) {
        capture.body = body;
        return this;
      },
    };
    const req = { headers: { "x-request-id": "req-x" } } as unknown as Request;
    const next = () => {};
    errorHandler(
      new DomainError("INVALID_BOND_TRANSITION", "bad move", { from: "A" }),
      req as never,
      res as never,
      next as never,
    );
    expect(capture.status).toBe(400);
    expect(capture.body).toMatchObject({
      code: "INVALID_BOND_TRANSITION",
      message: "bad move",
    });
    // Database-style error: no SQL text leaks.
    errorHandler(
      Object.assign(
        new Error('relation "agents" does not exist; password=hunter2'),
        {
          code: "42P01",
        },
      ),
      req as never,
      res as never,
      next as never,
    );
    expect(capture.status).toBe(500);
    expect(capture.body).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(capture.body)).not.toContain("hunter2");
    expect(JSON.stringify(capture.body)).not.toContain("42P01");
    // Adapter-style error: fixed safe message, internals logged only.
    errorHandler(
      new MidnightError(
        "MIDNIGHT_SUBMISSION_FAILED",
        "boom (SecretProviderImpl)",
        "REAL",
        {},
      ),
      req as never,
      res as never,
      next as never,
    );
    expect(capture.status).toBe(502);
    expect(capture.body).toMatchObject({
      code: "MIDNIGHT_SUBMISSION_FAILED",
      message: "Transaction submission failed",
    });
    expect(JSON.stringify(capture.body)).not.toContain("SecretProviderImpl");
  });
});

describe("production configuration", () => {
  it("keeps useful development defaults", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://x",
    } as NodeJS.ProcessEnv);
    expect(config.nodeEnv).toBe("development");
    expect(config.corsOrigins).toEqual(["http://localhost:5173"]);
    expect(config.bodyLimit).toBe("100kb");
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.shutdownTimeoutMs).toBe(10000);
  });
});
