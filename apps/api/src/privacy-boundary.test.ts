/**
 * Privacy boundary regression tests (Phase 26).
 *
 * Locks the guarantees the data-flow map depends on:
 * - API error bodies contain exactly {code, message, requestId} —
 *   DomainError `details` (which carry raw values) never serialize,
 *   even when stuffed with canary secrets.
 * - The /ready worker lastError projection scrubs secret-shaped
 *   content while passing operational messages through.
 * - Public ledger views expose bands/statuses/counts only.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { DomainError } from "@bond/shared-types";
import { MidnightError } from "@bond/midnight-adapter";
import { errorHandler } from "./http/errors.js";
import { sanitizePublicErrorMessage } from "./http/routes/system.js";
import {
  CONTRACT_POLICY_VERSION,
  CONTRACT_VERSION,
  emptyLedger,
  lockBond,
  registerAgent,
  toPublicContractLedgerView,
} from "@bond/contract";

beforeAll(async () => {
  await useIsolatedDb("privacyboundary");
});

const DEV_KEY = "test-dev-key";

function errorBodyOf(res: { body: unknown; status: number }) {
  expect(typeof res.body).toBe("object");
  expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual([
    "code",
    "message",
    "requestId",
  ]);
  return res.body as { code: string; message: string };
}

function invokeErrorHandler(error: unknown): {
  status: number;
  body: unknown;
} {
  let status = 0;
  let body: unknown = null;
  const req = { headers: {} } as Request;
  const res = {
    status(code: number) {
      status = code;
      return {
        json(payload: unknown) {
          body = payload;
        },
      };
    },
  } as unknown as Response;
  errorHandler(error, req, res, (() => {}) as never);
  return { status, body };
}

describe("error body shape", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("live endpoints return exactly {code, message, requestId}", async () => {
    const app = createApp();
    process.env.DEV_AUTH_TOKEN = DEV_KEY;
    const noAuth = await request(app).get("/api/v1/agents/nope");
    expect(noAuth.status).toBe(401);
    errorBodyOf(noAuth);

    const sess = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: DEV_KEY, externalKey: "op-privacy-1" });
    const token = sess.body.data.token as string;
    const missing = await request(app)
      .get("/api/v1/agents/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
    errorBodyOf(missing);

    const badBody = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ platform: "custom" });
    expect(badBody.status).toBe(400);
    errorBodyOf(badBody);
  });

  it("DomainError details carrying canaries never serialize", async () => {
    const canary = new DomainError("INVALID_ACTIVITY_INPUT", "Bad field", {
      field: "metadata",
      value: "sk-canary-secret-001",
      witness: "witness-canary-002",
    });
    const { status, body } = invokeErrorHandler(canary);
    expect(status).toBe(400);
    const parsed = errorBodyOf({ body, status });
    expect(parsed.code).toBe("INVALID_ACTIVITY_INPUT");
    expect(JSON.stringify(body)).not.toContain("sk-canary-secret-001");
    expect(JSON.stringify(body)).not.toContain("witness-canary-002");
  });

  it("unknown errors become generic INTERNAL_ERROR without internals", async () => {
    const err = new Error(
      "pg connection failed with password=hunter2 for witness-canary-003",
    );
    (err as { stack?: string }).stack =
      "Error: boom\n    at SecretModule (/app/src/secret.ts:1:1)";
    const { status, body } = invokeErrorHandler(err);
    expect(status).toBe(500);
    const parsed = errorBodyOf({ body, status });
    expect(parsed.code).toBe("INTERNAL_ERROR");
    expect(parsed.message).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("MidnightError maps to safe messages, never raw text", async () => {
    const err = new MidnightError(
      "MIDNIGHT_SUBMISSION_FAILED",
      "tx 0xdeadbeef rejected: witness witness-canary-004 invalid",
      "REAL",
      {},
    );
    const { body } = invokeErrorHandler(err);
    expect(JSON.stringify(body)).not.toContain("witness-canary-004");
    expect(JSON.stringify(body)).not.toContain("0xdeadbeef");
  });
});

describe("sanitizePublicErrorMessage", () => {
  it("passes null and ordinary operational text through", async () => {
    expect(sanitizePublicErrorMessage(null)).toBeNull();
    expect(
      sanitizePublicErrorMessage(
        "duplicate key value violates unique constraint",
      ),
    ).toBe("duplicate key value violates unique constraint");
    expect(
      sanitizePublicErrorMessage("REAL submission requires operator attention"),
    ).toBe("REAL submission requires operator attention");
  });

  it("redacts credential assignments, tokens, PEM blocks, and URL passwords", async () => {
    expect(
      sanitizePublicErrorMessage("connect failed: password=hunter2 retrying"),
    ).toBe("connect failed: [redacted] retrying");
    expect(sanitizePublicErrorMessage("got Bearer abcDEF123-_.~+/= done")).toBe(
      "got [redacted] done",
    );
    expect(
      sanitizePublicErrorMessage("key -----BEGIN PRIVATE KEY----- data"),
    ).toBe("key [redacted] data");
    expect(
      sanitizePublicErrorMessage(
        "dial postgresql://bond:hunter2@db:5432/bond failed",
      ),
    ).toBe("dial [redacted]db:5432/bond failed");
    expect(
      sanitizePublicErrorMessage("store mnemonic: abandon abandon ability"),
    ).toBe("store [redacted]");
    // Conservative by design on a public endpoint: any mention of
    // mnemonic/seed material redacts, even without an attached value.
    expect(sanitizePublicErrorMessage("mnemonic words leaked here")).toBe(
      "[redacted]",
    );
  });
});

describe("public ledger view shape", () => {
  it("exposes bands and counts, never amounts or commitments", async () => {
    let ledger = emptyLedger(CONTRACT_VERSION, CONTRACT_POLICY_VERSION);
    ledger = registerAgent(ledger, {
      agentId: "agent-001",
      operatorId: "op-001",
      caller: { kind: "operator", operatorId: "op-001" },
    });
    ledger = lockBond(ledger, {
      bondId: "bond-001",
      agentId: "agent-001",
      operatorId: "op-001",
      commitmentMinorUnits: "424242424242",
      caller: { kind: "operator", operatorId: "op-001" },
    });
    const view = toPublicContractLedgerView(ledger);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("424242424242");
    expect(serialized).not.toContain("commitment");
    expect(serialized).not.toContain("witness");
    expect(serialized).not.toContain("operatorSecret");
    expect(serialized).not.toContain("op-001");
    for (const agent of view.agents) {
      expect(Object.keys(agent).sort()).toEqual(
        ["agentId", "bondStatus", "slashCount", "status"].sort(),
      );
    }
  });
});
