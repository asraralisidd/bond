/**
 * API client, router, and state-behavior tests.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { parseHash, navigate } from "../app/router.js";
import { DataState } from "../components/DataState.js";
import { LoginPage } from "../pages/Login.js";
import { cleanup, flush, render, stubFetch } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("models backend errors with codes and request ids", () => {
    const err = new ApiError("NOT_FOUND", "Agent not found", 404, "req-9");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("req-9");
    expect(err).toBeInstanceOf(Error);
  });

  it("surfaces backend error codes and request ids on failure", async () => {
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async () =>
      ({
        ok: false,
        status: 409,
        headers: new Headers({ "x-request-id": "req-conflict" }),
        json: async () => ({ code: "IDEMPOTENCY_CONFLICT", message: "reused" }),
      }) as Response;
    const { api, getLastRequestId } = await import("../api/client.js");
    try {
      await api.listAgents();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("IDEMPOTENCY_CONFLICT");
      expect((err as ApiError).requestId).toBe("req-conflict");
      expect(getLastRequestId()).toBe("req-conflict");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("fires the unauthorized handler on 401 only", async () => {
    const { setUnauthorizedHandler } = await import("../api/client.js");
    const seen: string[] = [];
    setUnauthorizedHandler((err) => {
      seen.push(err.code);
    });
    const original = globalThis.fetch;
    const fail = (status: number) =>
      (async () =>
        ({
          ok: false,
          status,
          headers: new Headers({}),
          json: async () => ({ code: "X", message: "y" }),
        }) as Response) as typeof fetch;
    try {
      globalThis.fetch = fail(401);
      const { api } = await import("../api/client.js");
      await expect(api.listAgents()).rejects.toThrowError();
      expect(seen).toEqual(["X"]);

      globalThis.fetch = fail(403);
      await expect(api.listAgents()).rejects.toThrowError();
      expect(seen).toEqual(["X"]);
    } finally {
      globalThis.fetch = original;
      setUnauthorizedHandler(null);
    }
  });

  it("sends Idempotency-Key on mutating calls", async () => {
    const restore = stubFetch(() => ({ data: { ok: true } }));
    const { api } = await import("../api/client.js");
    await api.registerAgent({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: "ext-1",
    });
    const calls = (
      globalThis.fetch as unknown as {
        __calls: { url: string; init?: RequestInit }[];
      }
    ).__calls;
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{32}$/);
    restore();
  });

  it("sends Bearer token when a session exists", async () => {
    window.localStorage.setItem("bond.session.token", "tok-abc");
    const restore = stubFetch(() => ({ data: [] }));
    const { api } = await import("../api/client.js");
    await api.listAgents();
    const calls = (
      globalThis.fetch as unknown as {
        __calls: { url: string; init?: RequestInit }[];
      }
    ).__calls;
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    window.localStorage.removeItem("bond.session.token");
    restore();
  });
});

describe("router", () => {
  it("parses known routes and falls back safely", () => {
    expect(parseHash("#/agents/abc").name).toBe("agents");
    expect(parseHash("#/agents/abc").segments).toEqual(["agents", "abc"]);
    expect(parseHash("#/nope").name).toBe("dashboard");
    expect(parseHash("").name).toBe("dashboard");
    expect(typeof navigate).toBe("function");
  });
});

describe("shared states", () => {
  it("renders loading, error, empty, and content branches", async () => {
    const loading = await render(
      <DataState
        loading
        error={null}
        data={null}
        empty={{ title: "E", body: "B" }}
        onRetry={() => {}}
      >
        {() => "content"}
      </DataState>,
    );
    expect(loading.getAttribute("role")).toBeNull();
    expect(loading.innerHTML).toContain("skeleton");
    cleanup(loading);

    const failed = await render(
      <DataState
        loading={false}
        error={new ApiError("NOT_FOUND", "gone", 404, "req-1")}
        data={null}
        empty={{ title: "E", body: "B" }}
        onRetry={() => {}}
      >
        {() => "content"}
      </DataState>,
    );
    expect(failed.innerHTML).toContain("NOT_FOUND");
    expect(failed.innerHTML).toContain("req-1");
    cleanup(failed);

    const empty = await render(
      <DataState
        loading={false}
        error={null}
        data={[]}
        empty={{ title: "Empty!", body: "Nothing here" }}
        onRetry={() => {}}
      >
        {() => "content"}
      </DataState>,
    );
    expect(empty.innerHTML).toContain("Empty!");
    cleanup(empty);
  });

  it("login explains the wallet boundary", async () => {
    const container = await render(<LoginPage />);
    await flush();
    expect(container.innerHTML).toContain("Wallet connection unavailable");
    expect(container.innerHTML).toContain("Development");
    cleanup(container);
  });

  it("login shows the session-expired notice once", async () => {
    window.sessionStorage.setItem("bond.session.expired", "1");
    const container = await render(<LoginPage />);
    await flush();
    expect(container.innerHTML).toContain("expired");
    expect(window.sessionStorage.getItem("bond.session.expired")).toBeNull();
    cleanup(container);
  });

  it("renders a calm message for 429 without retrying automatically", async () => {
    const { friendlyMessage, ApiError: ClientApiError } =
      await import("../api/client.js");
    expect(
      friendlyMessage(new ClientApiError("RATE_LIMITED", "x", 429, "r1")),
    ).toBe("Too many requests — please wait a moment and try again.");
    expect(
      friendlyMessage(new ClientApiError("NOT_FOUND", "gone", 404, null)),
    ).toBe("NOT_FOUND: gone");

    const original = globalThis.fetch;
    let calls = 0;
    (globalThis as Record<string, unknown>).fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "x-request-id": "req-rl" }),
        json: async () => ({ code: "RATE_LIMITED", message: "slow down" }),
      } as Response;
    };
    try {
      const { api } = await import("../api/client.js");
      // Single attempt surfaces the backend error; no client retry storm.
      await expect(api.listAgents()).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
