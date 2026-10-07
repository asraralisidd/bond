/**
 * BondAgentClient + credential management tests. Mocked transport only.
 */
import { describe, expect, it } from "vitest";
import { BondAgentClient } from "./agent.js";
import { BondClient } from "./client.js";
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

function agentClient(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { agent: BondAgentClient; seen: SeenRequest[] } {
  const { fetchFn, seen } = mockFetch(handler);
  const transport = new BondClient({
    baseUrl: "https://api.example",
    token: "cred_test.secret",
    fetchFn,
  });
  return { agent: new BondAgentClient(transport), seen };
}

describe("credential management (operator client)", () => {
  it("creates credentials and surfaces the secret once", async () => {
    const { fetchFn, seen } = mockFetch((url, _init) => {
      if (url.endsWith("/credentials")) {
        if ((_init as { method?: string }).method === "GET") {
          return jsonResponse(200, {
            data: [{ credentialId: "cred_1", agentId: "a-1" }],
          });
        }
        return jsonResponse(201, {
          data: {
            metadata: { credentialId: "cred_1", agentId: "a-1" },
            secret: "s3cret",
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new BondClient({
      baseUrl: "https://api.example",
      token: "sess_x",
      fetchFn,
    });
    const created = await client.createAgentCredential("a-1");
    expect(created.secret).toBe("s3cret");
    expect(seen[0]?.url).toBe(
      "https://api.example/api/v1/agents/a-1/credentials",
    );
    const listed = await client.listAgentCredentials("a-1");
    expect(JSON.stringify(listed)).not.toContain("s3cret");
  });

  it("rotates and revokes through the expected paths", async () => {
    const { fetchFn, seen } = mockFetch((url, init) => {
      if ((init as { method?: string }).method === "DELETE") {
        const credentialId = url.split("/").pop() ?? "cred_1";
        return jsonResponse(200, {
          data: { revoked: true, credentialId },
        });
      }
      return jsonResponse(201, {
        data: {
          metadata: { credentialId: "cred_2" },
          secret: "new-secret",
        },
      });
    });
    const client = new BondClient({
      baseUrl: "https://api.example",
      token: "sess_x",
      fetchFn,
    });
    const rotated = await client.rotateAgentCredential("a-1", "cred_1");
    expect(rotated.secret).toBe("new-secret");
    expect(seen[0]?.url).toBe(
      "https://api.example/api/v1/agents/a-1/credentials/cred_1/rotate",
    );
    const revoked = await client.revokeAgentCredential("a-1", "cred_2");
    expect(revoked).toEqual({ revoked: true, credentialId: "cred_2" });
    expect(seen[1]?.url).toBe(
      "https://api.example/api/v1/agents/a-1/credentials/cred_2",
    );
  });
});

describe("BondAgentClient surface", () => {
  it("exposes only agent-readable operations", () => {
    const names = Object.getOwnPropertyNames(BondAgentClient.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(names.sort()).toEqual(
      [
        "analyzeActivity",
        "getAgent",
        "getFlag",
        "getReputation",
        "lastRequestId",
        "listEvents",
        "listFlags",
        "setToken",
        "verifyAgent",
      ].sort(),
    );
    for (const forbidden of [
      "createBond",
      "createAgentCredential",
      "rotateAgentCredential",
      "revokeAgentCredential",
      "submitVerdict",
      "enforceAttestation",
      "registerAgent",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("delegates agent calls with the agent credential", async () => {
    const { agent, seen } = agentClient((_url, _init) =>
      jsonResponse(200, { data: { agentId: "a-1" } }),
    );
    await agent.getAgent("a-1");
    await agent.listFlags("a-1");
    await agent.getFlag("f-1");
    await agent.listEvents({ limit: 10 });
    await agent.verifyAgent("a-1");
    expect(seen).toHaveLength(5);
    for (const entry of seen) {
      const headers = entry.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer cred_test.secret");
    }
    expect(agent.lastRequestId).toBe("req-test-1");
  });

  it("propagates capability denials without retrying", async () => {
    const { agent } = agentClient((_url, _init) =>
      jsonResponse(
        403,
        { code: "FORBIDDEN", message: "Capability not granted" },
        {},
      ),
    );
    const error = await agent.listFlags("a-1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BondApiError);
    expect((error as BondApiError).code).toBe("FORBIDDEN");
  });

  it("setToken swaps the in-memory credential", async () => {
    const { agent, seen } = agentClient((_url, _init) =>
      jsonResponse(200, { data: {} }),
    );
    agent.setToken("cred_other.newsecret");
    await agent.getAgent("a-1");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cred_other.newsecret");
  });
});
