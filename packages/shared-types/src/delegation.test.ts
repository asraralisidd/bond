/**
 * Phase 23 delegation domain tests (pure).
 *
 * Covers: capability closed-set, scope validation, expiry bounds,
 * effective status, authorization predicate ordering (delegate →
 * revocation → expiry → capability → possession → scope),
 * attribution derivation, and determinism.
 */
import { describe, expect, it } from "vitest";
import {
  DELEGABLE_CAPABILITIES,
  authorizeDelegation,
  deriveAttribution,
  effectiveDelegationStatus,
  validateDelegationCapabilities,
  validateDelegationExpiry,
  validateDelegationScope,
} from "./delegation.js";
import type { DelegationUseInput } from "./delegation.js";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const HOUR = 3_600_000;

function useInput(
  overrides: Partial<DelegationUseInput> = {},
): DelegationUseInput {
  return {
    delegateAgentId: "agent-b",
    requiredCapability: "activity:submit",
    delegation: {
      delegateAgentId: "agent-b",
      status: "active",
      expiresAt: new Date(NOW + HOUR).toISOString(),
      capabilities: ["activity:submit", "risk:read"],
      scope: { actionTypes: null, tools: null, models: null, providers: null },
    },
    delegatorCapabilities: ["activity:submit", "risk:read", "agent:read"],
    operation: { actionType: "transfer", tool: "transfers" },
    nowMs: NOW,
    ...overrides,
  };
}

describe("capability closed set", () => {
  it("accepts authentication capabilities only", () => {
    expect([...DELEGABLE_CAPABILITIES]).toEqual([
      "activity:submit",
      "agent:read",
      "risk:read",
      "verification:read",
      "reputation:read",
    ]);
    expect(
      validateDelegationCapabilities(["activity:submit", "risk:read"]),
    ).toEqual(["activity:submit", "risk:read"]);
  });

  it("rejects enforcement-adjacent and unknown capabilities", () => {
    for (const bad of [
      [],
      ["enforcement"],
      ["bond:withdraw"],
      ["policy:write"],
      ["credential:manage"],
      ["activity:submit", "enforcement"],
      ["ACTIVITY:SUBMIT"],
      "activity:submit",
    ]) {
      let code: string | null = null;
      try {
        validateDelegationCapabilities(bad);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code, JSON.stringify(bad)).toBe("INVALID_DELEGATION");
    }
  });
});

describe("scope and expiry validation", () => {
  it("resolves absent scope to unconstrained", () => {
    expect(validateDelegationScope(undefined)).toEqual({
      actionTypes: null,
      tools: null,
      models: null,
      providers: null,
    });
  });

  it("rejects oversized and empty scope entries", () => {
    for (const bad of [
      { tools: [""] },
      { tools: ["x".repeat(129)] },
      { tools: Array.from({ length: 101 }, (_, i) => `t${i}`) },
      { models: "acme" },
      [],
    ]) {
      let code: string | null = null;
      try {
        validateDelegationScope(bad as never);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code, JSON.stringify(bad)).toBe("INVALID_DELEGATION");
    }
  });

  it("bounds expiry to future within 90 days", () => {
    expect(
      validateDelegationExpiry(new Date(NOW + HOUR).toISOString(), NOW),
    ).toBeTruthy();
    for (const bad of [
      new Date(NOW - 1000).toISOString(),
      new Date(NOW).toISOString(),
      new Date(NOW + 91 * 24 * HOUR).toISOString(),
      "not-a-date",
      12345,
    ]) {
      let code: string | null = null;
      try {
        validateDelegationExpiry(bad, NOW);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code, String(bad)).toBe("INVALID_DELEGATION");
    }
  });
});

describe("effective status", () => {
  it("revocation wins; expiry is timestamp-evaluated", () => {
    expect(
      effectiveDelegationStatus({
        status: "revoked",
        expiresAt: new Date(NOW + HOUR).toISOString(),
        nowMs: NOW,
      }),
    ).toBe("revoked");
    expect(
      effectiveDelegationStatus({
        status: "active",
        expiresAt: new Date(NOW + HOUR).toISOString(),
        nowMs: NOW,
      }),
    ).toBe("active");
    expect(
      effectiveDelegationStatus({
        status: "active",
        expiresAt: new Date(NOW - 1000).toISOString(),
        nowMs: NOW,
      }),
    ).toBe("expired");
  });
});

describe("authorizeDelegation", () => {
  it("authorizes a valid delegated use", () => {
    expect(authorizeDelegation(useInput())).toEqual({ ok: true });
  });

  it("rejects each failure mode with its reason, in order", () => {
    const cases: [Partial<DelegationUseInput>, string][] = [
      // wrong delegate first, even when everything else fails too
      [
        {
          delegateAgentId: "agent-zzz",
          delegation: {
            ...useInput().delegation,
            status: "revoked",
            expiresAt: new Date(NOW - HOUR).toISOString(),
            capabilities: [],
          },
          delegatorCapabilities: [],
        },
        "wrong-delegate",
      ],
      [
        {
          delegation: { ...useInput().delegation, status: "revoked" },
        },
        "revoked",
      ],
      [
        {
          delegation: {
            ...useInput().delegation,
            expiresAt: new Date(NOW - 1000).toISOString(),
          },
        },
        "expired",
      ],
      [{ requiredCapability: "agent:read" }, "capability-not-delegated"],
      [
        {
          requiredCapability: "risk:read",
          delegatorCapabilities: ["activity:submit"],
        },
        "delegator-lacks-capability",
      ],
      [
        {
          delegation: {
            ...useInput().delegation,
            scope: {
              actionTypes: ["message"],
              tools: null,
              models: null,
              providers: null,
            },
          },
        },
        "scope-exceeded",
      ],
    ];
    for (const [override, reason] of cases) {
      expect(authorizeDelegation(useInput(override))).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it("treats null scope dimensions and null operation fields as open", () => {
    expect(
      authorizeDelegation(
        useInput({
          operation: {
            actionType: null,
            tool: null,
            model: null,
            provider: null,
          },
        }),
      ),
    ).toEqual({ ok: true });
    expect(authorizeDelegation(useInput({ operation: null }))).toEqual({
      ok: true,
    });
  });

  it("is deterministic", () => {
    expect(authorizeDelegation(useInput())).toEqual(
      authorizeDelegation(useInput()),
    );
  });
});

describe("deriveAttribution", () => {
  it("keeps executor identity and records the delegation", () => {
    expect(
      deriveAttribution({
        executorAgentId: "agent-b",
        delegation: { id: "dlg-1", delegatorAgentId: "agent-a" },
      }),
    ).toEqual({
      requesterAgentId: "agent-a",
      executorAgentId: "agent-b",
      delegationId: "dlg-1",
    });
  });

  it("maps direct activity to self-attribution", () => {
    expect(
      deriveAttribution({ executorAgentId: "agent-a", delegation: null }),
    ).toEqual({
      requesterAgentId: "agent-a",
      executorAgentId: "agent-a",
      delegationId: null,
    });
  });
});
