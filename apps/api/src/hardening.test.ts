import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { MidnightError } from "@bond/midnight-adapter";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { migrate } from "./db/migrate.js";
import { query } from "./db/pool.js";
import { consumeNullifier, isNullifierConsumed } from "./db/stores/chain.js";
import { errorHandler } from "./http/errors.js";
import { buildLogRecord } from "./observability.js";
import { emptyLogMetadata } from "@bond/shared-types";

beforeAll(async () => {
  await useIsolatedDb("hardening");
});

describe("hardening", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("migrations are idempotent and ordered", async () => {
    const url = process.env.DATABASE_URL as string;
    const first = await migrate(url);
    expect(first).toEqual([]);
    const tables: { rows: { tablename: string }[] } = await query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const names = tables.rows.map((r) => r.tablename);
    for (const expected of [
      "agents",
      "bonds",
      "protocol_events",
      "chain_transactions",
      "idempotency_keys",
      "nullifiers",
      "eligibility_proofs",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("protocol_events rejects UPDATE and DELETE (append-only trigger)", async () => {
    await query(
      `INSERT INTO protocol_events (id, type, actor) VALUES ('evt-1', 'AGENT_REGISTERED', 'test')`,
    );
    await expect(
      query("UPDATE protocol_events SET actor = 'x' WHERE id = 'evt-1'"),
    ).rejects.toThrowError(/append-only/);
    await expect(
      query("DELETE FROM protocol_events WHERE id = 'evt-1'"),
    ).rejects.toThrowError(/append-only/);
  });

  it("nullifier mirror dedupes within its domain only", async () => {
    expect(await consumeNullifier("enforcement", "null-1")).toBe(true);
    expect(await consumeNullifier("enforcement", "null-1")).toBe(false);
    expect(await isNullifierConsumed("enforcement", "null-1")).toBe(true);
    expect(await isNullifierConsumed("eligibility-proof", "null-1")).toBe(
      false,
    );
    expect(await consumeNullifier("eligibility-proof", "null-1")).toBe(true);
  });

  it("maps domain and adapter errors to safe HTTP responses", async () => {
    const res: {
      status: (code: number) => unknown;
      json: (body: unknown) => unknown;
      statusCode: number;
      body: unknown;
    } = {
      statusCode: 0,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const req = { headers: { "x-request-id": "req-test-1" } } as never;
    errorHandler(
      new DomainError("INVALID_BOND_TRANSITION", "bad move", { from: "A" }),
      req,
      res as never,
      (() => undefined) as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code: "INVALID_BOND_TRANSITION",
      message: "bad move",
      requestId: "req-test-1",
    });
    errorHandler(
      new MidnightError("MIDNIGHT_UNAVAILABLE", "no chain", "REAL", {}),
      req,
      res as never,
      (() => undefined) as never,
    );
    expect(res.statusCode).toBe(502);
    errorHandler(
      new Error("boom\nsecret-stack"),
      req,
      res as never,
      (() => undefined) as never,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal error",
      requestId: "req-test-1",
    });
  });

  it("logs carry correlation IDs and never private values", () => {
    const record = buildLogRecord(
      {
        metadata: {
          ...emptyLogMetadata(),
          requestId: "req-log-1",
          agentId: "agent-log-1" as never,
        },
        operation: "test-op",
      },
      "test message",
    );
    expect(record).toEqual({
      requestId: "req-log-1",
      agentId: "agent-log-1",
      riskFlagId: null,
      attestationId: null,
      transactionId: null,
      operation: "test-op",
      errorCode: null,
      msg: "test message",
    });
    const output = JSON.stringify(record);
    expect(output).not.toContain("witness");
    expect(output).not.toContain("secret");
    expect(Object.keys(record).sort()).toEqual(
      [
        "agentId",
        "attestationId",
        "errorCode",
        "msg",
        "operation",
        "requestId",
        "riskFlagId",
        "transactionId",
      ].sort(),
    );
  });
});
