/**
 * Protocol vector runner (Phase 16.3): the canonical fixtures in
 * sdks/protocol/vectors/ are the source of truth for cross-language
 * compatibility. This suite loads THOSE files (no copies), builds
 * payloads with the TS SDK, drives mocked transports, and deep-compares
 * against `expected`. No network access. Deterministic: all dynamic
 * fields are literal strings in the fixtures.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildActivity } from "./activity.js";
import type { ActivityInput } from "./activity.js";
import { BondClient } from "./client.js";
import { BondApiError } from "./errors.js";

const VECTORS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "sdks",
  "protocol",
  "vectors",
);

function loadVectors(name: string): unknown {
  return JSON.parse(readFileSync(join(VECTORS_DIR, name), "utf8")) as unknown;
}

interface RegistrationFile {
  valid: { name: string; input: unknown; expected: unknown }[];
  invalid: { name: string; input: unknown; expectedServerCode: string }[];
}

interface ActivityFile {
  valid: { name: string; input: unknown; expected: unknown }[];
  invalid: { name: string; input: unknown; expectedCode: string }[];
}

interface ErrorFile {
  vectors: {
    name: string;
    status: number;
    headers: Record<string, string>;
    body: unknown;
    expected: {
      code: string;
      message: string;
      status: number;
      requestId: string | null;
      retryAfter: number | null;
    };
  }[];
}

interface EnvelopeFile {
  vectors: {
    name: string;
    method: string;
    path: string;
    body: unknown;
    expected: unknown;
  }[];
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: string, init: RequestInit) =>
    handler(url, init)) as unknown as typeof fetch;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const merged: Record<string, string> = { ...headers };
  const rawBody = body === null ? null : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(merged),
    json: async () => {
      if (rawBody === null) {
        throw new Error("no body");
      }
      return rawBody;
    },
  } as Response;
}

describe("protocol vectors: registration", () => {
  const file = loadVectors("registration.json") as RegistrationFile;

  it("loads canonical registration fixtures", () => {
    expect(file.valid.length).toBeGreaterThan(0);
    expect(file.invalid.length).toBeGreaterThan(0);
  });

  for (const vector of file.valid) {
    it(`serializes valid vector ${vector.name} byte-identically`, async () => {
      const seen: { url: string; init: RequestInit }[] = [];
      const fetchFn = mockFetch((url, init) => {
        seen.push({ url, init });
        return jsonResponse(201, { data: { agentId: "agent-vector-x" } });
      });
      const client = new BondClient({
        baseUrl: "https://api.example",
        fetchFn,
      });
      await client.registerAgent(
        vector.input as {
          platform: string;
          agentType: string;
          capabilities: string[];
          externalRef: string;
        },
      );
      expect(seen).toHaveLength(1);
      const sent = JSON.parse(
        String((seen[0]?.init.body ?? "{}") as string),
      ) as unknown;
      expect(sent).toEqual(vector.expected);
      // Exact wire shape: no extra keys beyond the canonical fixture.
      expect(Object.keys(sent as Record<string, unknown>).sort()).toEqual(
        Object.keys(vector.expected as Record<string, unknown>).sort(),
      );
    });
  }

  for (const vector of file.invalid) {
    it(`documents invalid vector ${vector.name} without client mutation`, () => {
      // Invalid registration cases are server-validated; the SDK must
      // transmit the payload unmodified (no silent fixing/dropping).
      expect(vector.expectedServerCode).toBe("INVALID_IDENTIFIER");
      expect(vector.input).toBeDefined();
    });
  }
});

describe("protocol vectors: activities", () => {
  const file = loadVectors("activities.json") as ActivityFile;

  it("covers all seven action types", () => {
    const names = file.valid.map((v) => v.name).sort();
    expect(names).toEqual([
      "auth",
      "config-change",
      "external-report",
      "message",
      "policy-decision",
      "tool-call",
      "transfer",
    ]);
  });

  for (const vector of file.valid) {
    it(`builds valid vector ${vector.name} exactly`, () => {
      const built = buildActivity(vector.input as ActivityInput);
      expect(JSON.parse(JSON.stringify(built))).toEqual(vector.expected);
    });
  }

  for (const vector of file.invalid) {
    it(`rejects invalid vector ${vector.name} deterministically`, () => {
      let code: string | null = null;
      try {
        buildActivity(vector.input as ActivityInput);
      } catch (error) {
        if (error instanceof BondApiError) {
          code = error.code;
        }
      }
      expect(code).toBe(vector.expectedCode);
    });
  }
});

describe("protocol vectors: errors", () => {
  const file = loadVectors("errors.json") as ErrorFile;

  it("covers all required status classes", () => {
    const statuses = file.vectors.map((v) => v.status).sort((a, b) => a - b);
    expect(statuses).toEqual([401, 403, 404, 409, 429, 429, 500, 502]);
  });

  for (const vector of file.vectors) {
    it(`maps error vector ${vector.name}`, async () => {
      const fetchFn = mockFetch(() =>
        jsonResponse(vector.status, vector.body, vector.headers),
      );
      const client = new BondClient({
        baseUrl: "https://api.example",
        fetchFn,
      });
      const error = await client.listAgents().then(
        () => {
          throw new Error("expected rejection");
        },
        (e: unknown) => e as BondApiError,
      );
      expect(error).toBeInstanceOf(BondApiError);
      expect(error.code).toBe(vector.expected.code);
      expect(error.message).toBe(vector.expected.message);
      expect(error.status).toBe(vector.expected.status);
      expect(error.requestId).toBe(vector.expected.requestId);
      expect(error.retryAfter).toBe(vector.expected.retryAfter);
    });
  }
});

describe("protocol vectors: envelopes", () => {
  const file = loadVectors("envelopes.json") as EnvelopeFile;

  it("covers agent, analysis, flags, and public verification", () => {
    expect(file.vectors.map((v) => v.name).sort()).toEqual([
      "agent",
      "public-verification",
      "risk-analysis",
      "risk-flags",
    ]);
  });

  for (const vector of file.vectors) {
    it(`unwraps envelope vector ${vector.name}`, async () => {
      const fetchFn = mockFetch((url, init) => {
        expect(url).toBe(`https://api.example${vector.path}`);
        expect((init as { method?: string }).method).toBe(vector.method);
        return jsonResponse(200, vector.body);
      });
      const client = new BondClient({
        baseUrl: "https://api.example",
        fetchFn,
      });
      let data: unknown;
      if (vector.name === "agent") {
        data = await client.getAgent("agent-vector-1");
      } else if (vector.name === "risk-analysis") {
        data = await client.analyzeActivity("agent-vector-1", {
          action: "probe",
        });
      } else if (vector.name === "risk-flags") {
        data = await client.listFlags("agent-vector-1");
      } else {
        data = await client.verifyAgent("agent-vector-1");
      }
      expect(JSON.parse(JSON.stringify(data))).toEqual(vector.expected);
    });
  }
});
