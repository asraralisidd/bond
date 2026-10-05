import { describe, expect, it } from "vitest";
import {
  ENGINE_VERSION,
  RISK_ENGINE_STATUS,
  analyzeActivity,
} from "@bond/risk-engine";
import { ATTESTOR_STATUS, createAttestor, decide } from "@bond/attestor";
import {
  createRiskFlag,
  parseAgentId,
  parseEvidenceId,
  parseRiskFlagId,
} from "@bond/shared-types";
import { MIDNIGHT_ADAPTER_STATUS } from "@bond/midnight-adapter";

describe("foundation shells", () => {
  it("midnight-adapter remains an unimplemented shell", () => {
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

  it("attestor system is implemented as independent quorum (Phase 3)", () => {
    expect(ATTESTOR_STATUS).toBe("independent-v1");
    // Quorum proof: two independent attestors confirm a strong flag and
    // the decision carries an enforcement recommendation — but no
    // enforcement itself happens here.
    const flag = createRiskFlag({
      riskFlagId: parseRiskFlagId("flag-foundation"),
      agentId: parseAgentId("agent-001"),
      category: "unauthorized-action",
      severity: "high",
      confidence: 0.9,
      evidenceRefs: [
        {
          evidenceId: parseEvidenceId("ev-001"),
          category: "tool-call-log",
          contentHash: "bond-risk-digest:ffff0001",
        },
      ],
      detectedAt: "2026-10-01T12:00:00.000Z",
      modelVersion: "test-scorer/v1",
    });
    const profile = (id: string) => ({
      attestor: createAttestor({
        attestorId: id,
        organization: `Org ${id}`,
        registeredAt: "2026-09-01T00:00:00.000Z",
      }),
      strictness: 0 as const,
    });
    const outcome = decide({
      attestationId: "att-foundation",
      flag,
      availableEvidenceIds: new Set(["ev-001"]),
      profiles: [profile("attestor-a"), profile("attestor-b")],
      requestedAt: "2026-10-01T13:00:00.000Z",
      expiresAt: "2026-10-08T00:00:00.000Z",
      policyVersion: "policy v3",
      nowIso: "2026-10-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("quorum-met");
    expect(outcome.attestation.decision).not.toBeNull();
  });
});
