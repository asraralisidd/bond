import { describe, expect, it } from "vitest";
import {
  ENGINE_VERSION,
  RISK_ENGINE_STATUS,
  analyzeActivity,
} from "@bond/risk-engine";
import { ATTESTOR_STATUS } from "@bond/attestor";
import { MIDNIGHT_ADAPTER_STATUS } from "@bond/midnight-adapter";

describe("foundation shells", () => {
  it("attestor and midnight-adapter remain unimplemented shells", () => {
    expect(ATTESTOR_STATUS).toBe("not-implemented");
    expect(MIDNIGHT_ADAPTER_STATUS).toBe("not-implemented");
  });

  it("risk engine is implemented as advisory-only (Phase 2)", () => {
    expect(RISK_ENGINE_STATUS).toBe("rule-based-v1");
    expect(ENGINE_VERSION).toBe("engine-v1");
    // Advisory proof: benign activity yields no flags and no enforcement
    // surface — only risk information.
    const result = analyzeActivity({
      activityId: "act-foundation",
      agentId: "agent-001",
      occurredAt: "2026-10-01T12:00:00.000Z",
      actionType: "tool-call",
      action: "read-file",
      policyContext: {
        policyVersion: "policy v3",
        allowedActions: ["read-file"],
      },
    });
    expect(result.flags).toEqual([]);
    expect(result.score).toBeNull();
  });
});
