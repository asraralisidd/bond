import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { createAttestor, defaultEligibilityPolicy } from "./attestor.js";
import { createQuorumConfig } from "./policy.js";
import { decide } from "./decision.js";
import {
  EXPIRES_AT,
  FULL_EVIDENCE,
  NOW,
  REQUESTED_AT,
  lenientProfile,
  makeFlag,
  standardProfile,
  strictProfile,
  suspendedProfile,
} from "./fixtures.js";

function profiles() {
  return [
    standardProfile("attestor-a", "Org A"),
    standardProfile("attestor-b", "Org B"),
    standardProfile("attestor-c", "Org C"),
  ];
}

describe("decision orchestration", () => {
  it("reaches quorum-met with action and nullifier on strong findings", () => {
    const outcome = decide({
      attestationId: "att-001",
      flag: makeFlag(),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: profiles(),
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(outcome.status).toBe("quorum-met");
    expect(outcome.recommendedAction).toBe("partial-slash");
    expect(outcome.nullifier).toBe("bond-nullifier:att-001:flag-001");
    expect(outcome.attestation.status).toBe("decided");
    expect(outcome.attestation.decision).not.toBeNull();
    expect(outcome.evaluations).toHaveLength(3);
  });

  it("recommends full-slash for critical findings", () => {
    const outcome = decide({
      attestationId: "att-002",
      flag: makeFlag({
        severity: "critical",
        confidence: 0.9,
        flagId: "flag-002",
      }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: profiles(),
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(outcome.status).toBe("quorum-met");
    expect(outcome.recommendedAction).toBe("full-slash");
  });

  it("rejects weak findings with no action", () => {
    const outcome = decide({
      attestationId: "att-003",
      flag: makeFlag({ severity: "high", confidence: 0.3, flagId: "flag-003" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: profiles(),
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.recommendedAction).toBeNull();
    expect(outcome.nullifier).toBeNull();
  });

  it("stays open on a single attestor and expires past deadline", () => {
    const single = decide({
      attestationId: "att-004",
      flag: makeFlag({ flagId: "flag-004" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [standardProfile("attestor-a", "Org A")],
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(single.status).toBe("open");
    const expired = decide({
      attestationId: "att-005",
      flag: makeFlag({ flagId: "flag-005" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: profiles(),
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(expired.status).toBe("expired");
    expect(expired.recommendedAction).toBeNull();
  });

  it("excludes ineligible attestors and collapses duplicate profiles", () => {
    const outcome = decide({
      attestationId: "att-006",
      flag: makeFlag({ flagId: "flag-006" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [
        standardProfile("attestor-a", "Org A"),
        suspendedProfile("attestor-d", "Org D"),
        standardProfile("attestor-a", "Org A"),
        strictProfile("attestor-b", "Org B"),
      ],
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(outcome.ineligibleAttestors).toEqual(["attestor-d"]);
    // a twice + b once → 2 unique confirms → quorum-met.
    expect(outcome.status).toBe("quorum-met");
    expect(
      outcome.attestation.verdicts.filter((v) => v.attestorId === "attestor-a"),
    ).toHaveLength(1);
  });

  it("supports custom quorum formations and is deterministic", () => {
    const outcome = decide({
      attestationId: "att-007",
      flag: makeFlag({ flagId: "flag-007" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [standardProfile("attestor-a", "Org A")],
      quorum: createQuorumConfig(1, 1),
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(outcome.status).toBe("quorum-met");
    const repeat = decide({
      attestationId: "att-007",
      flag: makeFlag({ flagId: "flag-007" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [standardProfile("attestor-a", "Org A")],
      quorum: createQuorumConfig(1, 1),
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(repeat).toEqual(outcome);
    // Mixed strictness on a borderline flag stays deterministic too.
    const borderline = {
      attestationId: "att-008",
      flag: makeFlag({
        severity: "medium",
        confidence: 0.8,
        flagId: "flag-008",
      }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [
        standardProfile("attestor-a", "Org A"),
        strictProfile("attestor-b", "Org B"),
        lenientProfile("attestor-c", "Org C"),
      ],
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    };
    expect(decide(borderline)).toEqual(decide(borderline));
  });

  it("validates attestor identity and default eligibility", () => {
    expect(() =>
      createAttestor({
        attestorId: "",
        organization: "Org",
        registeredAt: "x",
      }),
    ).toThrowError(DomainError);
    expect(
      defaultEligibilityPolicy.isEligible(
        standardProfile("a", "Org A").attestor,
      ),
    ).toBe(true);
    expect(
      defaultEligibilityPolicy.isEligible(
        suspendedProfile("d", "Org D").attestor,
      ),
    ).toBe(false);
  });
});
