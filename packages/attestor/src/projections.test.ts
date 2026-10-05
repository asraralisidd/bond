import { describe, expect, it } from "vitest";
import { decide } from "./decision.js";
import { toPublicAttestationView } from "./projections.js";
import {
  EXPIRES_AT,
  FULL_EVIDENCE,
  NOW,
  REQUESTED_AT,
  makeFlag,
  standardProfile,
} from "./fixtures.js";

describe("public attestation projections", () => {
  it("exposes counts and status, never sensitive material", () => {
    const outcome = decide({
      attestationId: "att-101",
      flag: makeFlag({ flagId: "flag-101" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [
        standardProfile("attestor-a", "Org A"),
        standardProfile("attestor-b", "Org B"),
        standardProfile("attestor-c", "Org C"),
      ],
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    const view = toPublicAttestationView(outcome.attestation);
    expect(view).toEqual({
      attestationId: "att-101",
      riskFlagId: "flag-101",
      agentId: "agent-001",
      status: "decided",
      threshold: 2,
      confirms: 3,
      rejects: 0,
      abstains: 0,
      decisionAction: "partial-slash",
      expiresAt: EXPIRES_AT,
    });
    const serialized = JSON.stringify(view);
    for (const token of [
      "nullifier",
      "bindingRef",
      "binding:",
      "rationale",
      "bond-nullifier",
    ]) {
      expect(serialized.includes(token)).toBe(false);
    }
  });
});
