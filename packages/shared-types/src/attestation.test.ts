import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  parseAgentId,
  parseAttestationId,
  parseAttestorId,
  parseDecisionId,
  parseEvidenceId,
  parseRiskFlagId,
} from "./ids.js";
import {
  createAttestationRequest,
  isAttestationFresh,
  isDecisionReplay,
  issueDecision,
  recordVerdict,
} from "./attestation.js";
import type { Attestation } from "./attestation.js";

function validRequest(): Attestation {
  return createAttestationRequest({
    attestationId: parseAttestationId("att-001"),
    riskFlagId: parseRiskFlagId("flag-001"),
    agentId: parseAgentId("agent-001"),
    evidenceRefs: [parseEvidenceId("ev-001")],
    policyVersion: "policy v3",
    threshold: 2,
    requestedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
  });
}

describe("attestation domain", () => {
  it("creates a request in requested status", () => {
    const att = validRequest();
    expect(att.status).toBe("requested");
    expect(att.verdicts).toEqual([]);
    expect(att.decision).toBeNull();
  });

  it("validates threshold, policy, and expiry ordering", () => {
    const base = {
      attestationId: parseAttestationId("att-x"),
      riskFlagId: parseRiskFlagId("flag-x"),
      agentId: parseAgentId("agent-x"),
      evidenceRefs: [],
      policyVersion: "policy v3",
      threshold: 2,
      requestedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-08T00:00:00.000Z",
    };
    expect(() =>
      createAttestationRequest({ ...base, threshold: 0 }),
    ).toThrowError(DomainError);
    expect(() =>
      createAttestationRequest({ ...base, policyVersion: "" }),
    ).toThrowError(DomainError);
    expect(() =>
      createAttestationRequest({
        ...base,
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrowError(DomainError);
  });

  it("reaches quorum-met on two confirms (2-of-3 concept)", () => {
    let att = validRequest();
    att = recordVerdict(att, {
      attestorId: parseAttestorId("attestor-a"),
      verdict: "confirm",
      bindingRef: "bind-a",
      issuedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(att.status).toBe("requested");
    att = recordVerdict(att, {
      attestorId: parseAttestorId("attestor-b"),
      verdict: "confirm",
      bindingRef: "bind-b",
      issuedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(att.status).toBe("quorum-met");
  });

  it("rejects on threshold rejects and records abstentions neutrally", () => {
    let att = validRequest();
    att = recordVerdict(att, {
      attestorId: parseAttestorId("attestor-a"),
      verdict: "abstain",
      bindingRef: "bind-a",
      issuedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(att.status).toBe("requested");
    att = recordVerdict(att, {
      attestorId: parseAttestorId("attestor-b"),
      verdict: "reject",
      bindingRef: "bind-b",
      issuedAt: "2026-10-03T00:00:00.000Z",
    });
    att = recordVerdict(att, {
      attestorId: parseAttestorId("attestor-c"),
      verdict: "reject",
      bindingRef: "bind-c",
      issuedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(att.status).toBe("rejected");
  });

  it("rejects duplicate attestors, empty bindings, and late verdicts", () => {
    let att = validRequest();
    att = recordVerdict(att, {
      attestorId: parseAttestorId("attestor-a"),
      verdict: "confirm",
      bindingRef: "bind-a",
      issuedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(() =>
      recordVerdict(att, {
        attestorId: parseAttestorId("attestor-a"),
        verdict: "reject",
        bindingRef: "bind-a2",
        issuedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).toThrowError(DomainError);
    expect(() =>
      recordVerdict(att, {
        attestorId: parseAttestorId("attestor-b"),
        verdict: "confirm",
        bindingRef: "",
        issuedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).toThrowError(DomainError);
    try {
      recordVerdict(att, {
        attestorId: parseAttestorId("attestor-b"),
        verdict: "confirm",
        bindingRef: "bind-b",
        issuedAt: "2026-11-01T00:00:00.000Z",
      });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("EXPIRED_ATTESTATION");
    }
  });

  it("issues a single decision and detects replay via nullifiers", () => {
    let att = validRequest();
    for (const id of ["attestor-a", "attestor-b"]) {
      att = recordVerdict(att, {
        attestorId: parseAttestorId(id),
        verdict: "confirm",
        bindingRef: `bind-${id}`,
        issuedAt: "2026-10-02T00:00:00.000Z",
      });
    }
    att = issueDecision(att, {
      decisionId: parseDecisionId("dec-001"),
      action: "partial-slash",
      nullifier: "nullifier-001",
      decisionExpiresAt: "2026-10-09T00:00:00.000Z",
      nowIso: "2026-10-04T00:00:00.000Z",
    });
    expect(att.status).toBe("decided");
    expect(att.decision).not.toBeNull();
    expect(isDecisionReplay(att.decision!, new Set())).toBe(false);
    expect(isDecisionReplay(att.decision!, new Set(["nullifier-001"]))).toBe(
      true,
    );
    // Second issuance for the same attestation is a replay.
    try {
      issueDecision(att, {
        decisionId: parseDecisionId("dec-002"),
        action: "partial-slash",
        nullifier: "nullifier-002",
        decisionExpiresAt: "2026-10-09T00:00:00.000Z",
        nowIso: "2026-10-04T00:00:00.000Z",
      });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("REPLAYED_ATTESTATION");
    }
  });

  it("refuses decisions without quorum or after expiry", () => {
    expect(() =>
      issueDecision(validRequest(), {
        decisionId: parseDecisionId("dec-001"),
        action: "dismiss",
        nullifier: "nullifier-001",
        decisionExpiresAt: "2026-10-09T00:00:00.000Z",
        nowIso: "2026-10-02T00:00:00.000Z",
      }),
    ).toThrowError(DomainError);
    expect(isAttestationFresh(validRequest(), "2026-10-02T00:00:00.000Z")).toBe(
      true,
    );
    expect(isAttestationFresh(validRequest(), "2026-11-02T00:00:00.000Z")).toBe(
      false,
    );
  });
});
