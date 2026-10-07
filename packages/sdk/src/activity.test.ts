/**
 * ActivityBuilder unit tests. Covers defaults, validation parity with
 * backend rules, all actionType values, and redaction wiring.
 */
import { describe, expect, it } from "vitest";
import { ACTIVITY_TYPES, buildActivity } from "./activity.js";
import { BondApiError } from "./errors.js";

const BASE = {
  agentId: "agent-1",
  actionType: "tool-call" as const,
  action: "pay-vendor",
  policyContext: { policyVersion: "bond-policy-v1" },
};

describe("buildActivity defaults", () => {
  it("generates activityId and occurredAt when omitted", () => {
    const first = buildActivity({ ...BASE });
    const second = buildActivity({ ...BASE });
    expect(first.activityId).toBeTruthy();
    expect(second.activityId).toBeTruthy();
    expect(first.activityId).not.toBe(second.activityId);
    expect(new Date(first.occurredAt).toISOString()).toBe(first.occurredAt);
  });

  it("respects caller-supplied ids and timestamps", () => {
    const built = buildActivity({
      ...BASE,
      activityId: "act-9",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(built.activityId).toBe("act-9");
    expect(built.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("buildActivity validation", () => {
  it("accepts every supported actionType", () => {
    expect(ACTIVITY_TYPES).toHaveLength(7);
    for (const actionType of ACTIVITY_TYPES) {
      const built = buildActivity({ ...BASE, actionType });
      expect(built.actionType).toBe(actionType);
    }
  });

  it("rejects unknown action types", () => {
    expect(() =>
      buildActivity({ ...BASE, actionType: "nonsense" as never }),
    ).toThrowError(BondApiError);
  });

  it("rejects empty agentId, action, policyVersion, and bad timestamps", () => {
    expect(() => buildActivity({ ...BASE, agentId: "" })).toThrowError(
      /agentId/,
    );
    expect(() => buildActivity({ ...BASE, action: "  " })).toThrowError(
      /action/,
    );
    expect(() =>
      buildActivity({
        ...BASE,
        policyContext: { policyVersion: "" },
      }),
    ).toThrowError(/policyVersion/);
    expect(() =>
      buildActivity({ ...BASE, occurredAt: "yesterday" }),
    ).toThrowError(/occurredAt/);
    expect(() =>
      buildActivity({ ...BASE, policyContext: undefined as never }),
    ).toThrowError(/policyContext/);
  });

  it("carries optional fields and redacts secret metadata", () => {
    const built = buildActivity({
      ...BASE,
      tool: "transfers",
      amountMinorUnits: "100",
      externalDestination: true,
      bytesOut: 42,
      textSnippet: "s".repeat(600),
      metadata: { model: "m", apiKey: "sk-secret" },
      reporterSeverity: "high",
    });
    expect(built.tool).toBe("transfers");
    expect(built.amountMinorUnits).toBe("100");
    expect(built.externalDestination).toBe(true);
    expect(built.bytesOut).toBe(42);
    expect(built.textSnippet).toBe("s".repeat(500));
    expect(built.metadata).toEqual({ model: "m" });
    expect(built.reporterSeverity).toBe("high");
  });
});
