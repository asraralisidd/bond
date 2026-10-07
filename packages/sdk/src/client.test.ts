/**
 * BondClient unit tests with mocked transport. No network access.
 */
import { describe, expect, it } from "vitest";
import { BondClient, newIdempotencyKey, resolveApiBase } from "./client.js";
import { BondApiError } from "./errors.js";

interface SeenRequest {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchFn: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      "x-request-id": "req-test-1",
      ...headers,
    }),
    json: async () => body,
  } as Response;
}

describe("construction", () => {
  it("requires a non-empty baseUrl", () => {
    expect(() => new BondClient({ baseUrl: "" })).toThrowError(BondApiError);
    expect(new BondClient({ baseUrl: "https://api.example" })).toBeInstanceOf(
      BondClient,
    );
  });

  it("resolves base URLs with production guardrails", () => {
    expect(resolveApiBase("https://api.example", false)).toBe(
      "https://api.example",
    );
    expect(resolveApiBase(undefined, false)).toBe("http://localhost:4000");
    expect(() => resolveApiBase(undefined, true)).toThrowError(BondApiError);
  });
});

describe("request handling", () => {
  it("builds URLs and sends bearer auth from a static token", async () => {
    const { fetchFn, seen } = mockFetch((_url, _init) =>
      jsonResponse(200, { data: { agentId: "a-1" } }),
    );
    const client = new BondClient({
      baseUrl: "https://api.example",
      token: "tok-123",
      fetchFn,
    });
    await client.getAgent("a-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.example/api/v1/agents/a-1");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("supports sync and async token providers, omitting empty tokens", async () => {
    const { fetchFn, seen } = mockFetch((_url, _init) =>
      jsonResponse(200, { data: [] }),
    );
    const asyncClient = new BondClient({
      baseUrl: "https://api.example",
      token: async () => "tok-async",
      fetchFn,
    });
    await asyncClient.listAgents();
    expect(
      (seen[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tok-async");

    seen.length = 0;
    const emptyClient = new BondClient({
      baseUrl: "https://api.example",
      token: () => "",
      fetchFn,
    });
    await emptyClient.listAgents();
    expect(
      (seen[0]?.init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("tracks request ids and unwraps envelopes", async () => {
    const { fetchFn } = mockFetch((_url, _init) =>
      jsonResponse(
        200,
        { data: { agentId: "a-2" } },
        { "x-request-id": "req-7" },
      ),
    );
    const client = new BondClient({ baseUrl: "https://api.example", fetchFn });
    const agent = await client.getAgent("a-2");
    expect(agent).toEqual({ agentId: "a-2" });
    expect(client.lastRequestId).toBe("req-7");
  });

  it("sends Idempotency-Key for idempotent mutations only", async () => {
    const { fetchFn, seen } = mockFetch((_url, _init) =>
      jsonResponse(201, { data: {} }),
    );
    const client = new BondClient({ baseUrl: "https://api.example", fetchFn });
    await client.registerAgent({
      platform: "p",
      agentType: "custom",
      capabilities: [],
      externalRef: "e",
    });
    const key = (seen[0]?.init.headers as Record<string, string>)[
      "Idempotency-Key"
    ];
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);

    seen.length = 0;
    await client.getAgent("a-1");
    expect(
      (seen[0]?.init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBeUndefined();
  });

  it("uses caller-supplied idempotency keys verbatim", async () => {
    const { fetchFn, seen } = mockFetch((_url, _init) =>
      jsonResponse(201, { data: { transactionId: "t-1" } }),
    );
    const client = new BondClient({ baseUrl: "https://api.example", fetchFn });
    await client.createTransaction({
      purpose: "FUND_BOND",
      agentId: "a-1",
      idempotencyKey: "caller-key-9",
    });
    const sent = JSON.parse(String(seen[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(sent.idempotencyKey).toBe("caller-key-9");
  });
});

describe("error mapping", () => {
  async function failingClient(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    onUnauthorized?: (error: BondApiError) => void,
  ): Promise<{ client: BondClient; error: BondApiError }> {
    const { fetchFn } = mockFetch((_url, _init) =>
      jsonResponse(status, body, headers),
    );
    const client = new BondClient({
      baseUrl: "https://api.example",
      token: "tok",
      fetchFn,
      onUnauthorized,
    });
    const error = await client
      .listAgents()
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((e: unknown) => e as BondApiError);
    expect(error).toBeInstanceOf(BondApiError);
    return { client, error };
  }

  it("maps 401/403/404/409 with codes and request ids", async () => {
    for (const [status, code] of [
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "IDEMPOTENCY_CONFLICT"],
    ] as const) {
      const { client, error } = await failingClient(
        status,
        { code, message: "m", requestId: "r" },
        { "x-request-id": "r" },
      );
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.requestId).toBe("r");
      expect(error.retryAfter).toBeNull();
      expect(client.lastRequestId).toBe("r");
    }
  });

  it("extracts Retry-After on 429 without retrying", async () => {
    let calls = 0;
    const { fetchFn } = mockFetch((_url, _init) => {
      calls += 1;
      return jsonResponse(
        429,
        { code: "RATE_LIMITED", message: "slow" },
        { "retry-after": "45" },
      );
    });
    const client = new BondClient({ baseUrl: "https://api.example", fetchFn });
    const error = (await client
      .listAgents()
      .catch((e: unknown) => e)) as BondApiError;
    expect(error).toBeInstanceOf(BondApiError);
    expect(error.retryAfter).toBe(45);
    expect(calls).toBe(1);
    const missing = await new BondClient({
      baseUrl: "https://api.example",
      fetchFn: mockFetch((_u, _i) =>
        jsonResponse(429, { code: "RATE_LIMITED", message: "slow" }),
      ).fetchFn,
    })
      .listAgents()
      .catch((e: unknown) => e);
    expect((missing as BondApiError).retryAfter).toBeNull();
  });

  it("maps 5xx and network failures without leaking credentials", async () => {
    const { error } = await failingClient(500, {
      code: "INTERNAL_ERROR",
      message: "boom",
    });
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.status).toBe(500);

    const netClient = new BondClient({
      baseUrl: "https://api.example",
      token: "super-secret-token",
      fetchFn: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    const netError = (await netClient
      .listAgents()
      .catch((e: unknown) => e)) as BondApiError;
    expect(netError.code).toBe("NETWORK_ERROR");
    expect(String(netError)).not.toContain("super-secret-token");
  });

  it("fires the unauthorized hook on 401 unless skipped", async () => {
    const seen: BondApiError[] = [];
    await failingClient(
      401,
      { code: "UNAUTHORIZED", message: "bad" },
      {},
      (e) => {
        seen.push(e);
      },
    );
    expect(seen).toHaveLength(1);

    // signOut skips the hook (avoids logout loops on expired sessions).
    const { fetchFn } = mockFetch((_url, _init) =>
      jsonResponse(401, { code: "UNAUTHORIZED", message: "bad" }),
    );
    const hookCalls: BondApiError[] = [];
    const client = new BondClient({
      baseUrl: "https://api.example",
      fetchFn,
      onUnauthorized: (e) => {
        hookCalls.push(e);
      },
    });
    await client.signOut().catch(() => undefined);
    expect(hookCalls).toHaveLength(0);
  });
});

describe("newIdempotencyKey", () => {
  it("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

describe("method coverage", () => {
  it("exposes every operation of the web client surface", async () => {
    const { fetchFn, seen } = mockFetch((_url, _init) =>
      jsonResponse(200, { data: {} }),
    );
    const client = new BondClient({ baseUrl: "https://api.example", fetchFn });
    const calls: [string, Promise<unknown>][] = [
      ["health", client.health()],
      ["ready", client.ready()],
      ["createSession", client.createSession("k", "e")],
      ["signOut", client.signOut()],
      ["requestWalletChallenge", client.requestWalletChallenge()],
      [
        "verifyWalletChallenge",
        client.verifyWalletChallenge("c", {
          data: "d",
          signature: "s",
          verifyingKey: "v",
        }),
      ],
      ["getAgent", client.getAgent("a")],
      [
        "registerAgent",
        client.registerAgent({
          platform: "p",
          agentType: "t",
          capabilities: [],
          externalRef: "e",
        }),
      ],
      ["setAgentStatus", client.setAgentStatus("a", "ACTIVE")],
      [
        "createBond",
        client.createBond({ agentId: "a", commitmentMinorUnits: "1" }),
      ],
      ["getBond", client.getBond("b")],
      ["setBondStatus", client.setBondStatus("b", "ACTIVE")],
      [
        "createTransaction",
        client.createTransaction({ purpose: "P", idempotencyKey: "k" }),
      ],
      ["getTransaction", client.getTransaction("t")],
      ["advanceTransaction", client.advanceTransaction("t", "PENDING")],
      ["recordWalletSubmission", client.recordWalletSubmission("t", "c")],
      ["confirmTransaction", client.confirmTransaction("t")],
      ["analyzeActivity", client.analyzeActivity("a", { action: "x" })],
      ["listFlags", client.listFlags("a")],
      ["getFlag", client.getFlag("f")],
      [
        "registerAttestor",
        client.registerAttestor({ organization: "o", secret: "s" }),
      ],
      [
        "requestAttestation",
        client.requestAttestation({
          flagId: "f",
          attestorIds: ["a"],
          expiresAt: "e",
        }),
      ],
      ["getAttestation", client.getAttestation("a")],
      ["evaluateAttestation", client.evaluateAttestation("a", 1)],
      ["issueDecision", client.issueDecision("a", "dismiss")],
      ["enforceAttestation", client.enforceAttestation("a", "1")],
      [
        "createEligibilityProof",
        client.createEligibilityProof({
          agentId: "a",
          bondId: "b",
          requiredMinimumMinorUnits: "1",
          nonce: "n",
          expiresAt: "e",
        }),
      ],
      ["getEligibility", client.getEligibility("e")],
      ["consumeEligibility", client.consumeEligibility("e", "n")],
      ["verifyAgent", client.verifyAgent("a")],
      ["verifyEligibility", client.verifyEligibility("a", "v1")],
    ];
    for (const [, promise] of calls) {
      await promise;
    }
    expect(seen.length).toBe(calls.length);
    const urls = seen.map((s) => s.url);
    for (const url of urls) {
      expect(url.startsWith("https://api.example/")).toBe(true);
    }
    expect(urls).toContain("https://api.example/api/v1/agents/a");
    expect(urls).toContain("https://api.example/health");
  });

  it("sends the attestor secret only as a header", async () => {
    const { fetchFn, seen } = mockFetch((_url, _init) =>
      jsonResponse(201, { data: { status: "ok", verdicts: 1 } }),
    );
    const client = new BondClient({ baseUrl: "https://api.example", fetchFn });
    await client.submitVerdict("a", {
      attestorId: "at",
      verdict: "confirm",
      secret: "shh-secret",
    });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["X-Attestor-Secret"]).toBe("shh-secret");
    expect(String(seen[0]?.init.body)).not.toContain("shh-secret");
  });
});
