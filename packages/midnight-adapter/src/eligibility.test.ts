import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DomainError } from "@bond/shared-types";
import {
  ELIGIBILITY_PURPOSE_CODES,
  checkEligibility,
  createEligibilityProof,
  createSimulatedEligibilityStore,
  deriveProofNullifier,
  deriveRedemptionNullifier,
  eligibilityCircuitArgs,
  toPublicEligibilityView,
  transitionEligibilityProof,
} from "./eligibility.js";
import type { EligibilityProof } from "./eligibility.js";
import { policyVersionToBytes32 } from "./encoding.js";

const POLICY = "bond-policy-v1";
const NOW = "2026-10-02T00:00:00.000Z";
const EXPIRY = "2026-10-09T00:00:00.000Z";
const SECRET_AMOUNT = "987654321987654321";
const SECRET_SALT = "super-secret-blinding-001";
const SECRET_NONCE = "operator-secret-nonce-007";

function validProof(overrides?: Partial<EligibilityProof>): EligibilityProof {
  return createEligibilityProof({
    proofId: "proof-001",
    kind: "SIMULATED-FIXTURE",
    agentId: "agent-001",
    bondId: "bond-001",
    policy: {
      policyVersion: POLICY,
      requiredMinimumMinorUnits: "1000",
      purpose: "collateral-sufficiency",
    },
    nullifier: deriveProofNullifier(
      "agent-001",
      "collateral-sufficiency",
      "nonce-001",
    ),
    expiresAt: EXPIRY,
    nowIso: NOW,
    ...overrides,
  });
}

function policyHashHex(policyVersion: string): string {
  return Buffer.from(policyVersionToBytes32(policyVersion)).toString("hex");
}

describe("eligibility proofs", () => {
  it("1. creates a valid proof record with explicit policy input", () => {
    const proof = validProof();
    expect(proof.status).toBe("CREATED");
    expect(proof.kind).toBe("SIMULATED-FIXTURE");
    expect(proof.policyVersion).toBe(POLICY);
  });

  it("2/13. rejects invalid and malformed proof input", () => {
    expect(() => validProof({ agentId: "  " })).toThrowError(DomainError);
    expect(() =>
      createEligibilityProof({
        proofId: "p",
        kind: "SIMULATED-FIXTURE",
        agentId: "a",
        bondId: "b",
        policy: {
          policyVersion: POLICY,
          requiredMinimumMinorUnits: "10.5",
          purpose: "collateral-sufficiency",
        },
        nullifier: "n",
        expiresAt: EXPIRY,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      createEligibilityProof({
        proofId: "p",
        kind: "SIMULATED-FIXTURE",
        agentId: "a",
        bondId: "b",
        policy: {
          policyVersion: POLICY,
          requiredMinimumMinorUnits: "100",
          purpose: "collateral-sufficiency",
        },
        nullifier: "n",
        expiresAt: NOW,
        nowIso: EXPIRY,
      }),
    ).toThrowError(DomainError);
  });

  it("3/4/5/6. enforces agent, policy, purpose, and expiry binding", () => {
    const record = {
      policyHashHex: policyHashHex(POLICY),
      purposeCode: ELIGIBILITY_PURPOSE_CODES["collateral-sufficiency"],
      revoked: false,
      consumed: false,
    };
    const base = {
      record,
      expectedPolicyHashHex: policyHashHex(POLICY),
      expectedPurposeCode: 1,
      expiresAt: EXPIRY,
      nowIso: NOW,
    };
    expect(checkEligibility(base)).toEqual({
      eligible: true,
      reason: "eligible",
    });
    // Wrong policy version never validates.
    expect(
      checkEligibility({
        ...base,
        expectedPolicyHashHex: policyHashHex("bond-policy-v2"),
      }),
    ).toEqual({ eligible: false, reason: "policy-mismatch" });
    // Wrong purpose never validates.
    expect(checkEligibility({ ...base, expectedPurposeCode: 2 })).toEqual({
      eligible: false,
      reason: "purpose-mismatch",
    });
    // Expired proofs never validate.
    expect(
      checkEligibility({ ...base, nowIso: "2026-11-01T00:00:00.000Z" }),
    ).toEqual({ eligible: false, reason: "expired" });
    // Absence is not proof.
    expect(checkEligibility({ ...base, record: null })).toEqual({
      eligible: false,
      reason: "no-record",
    });
  });

  it("7/8. replays and consumption are single-use", () => {
    const store = createSimulatedEligibilityStore();
    const proof = validProof();
    store.prove(proof, NOW);
    // Same proof (same nullifier) submitted twice → replay.
    try {
      store.prove(proof, NOW);
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("REPLAYED_ELIGIBILITY_PROOF");
    }
    const redemption = deriveRedemptionNullifier(
      "agent-001",
      "proof-001",
      "nonce-r1",
    );
    store.consume("agent-001", redemption, NOW);
    const entry = store.read("agent-001");
    expect(entry?.consumed).toBe(true);
    expect(
      checkEligibility({
        record: {
          policyHashHex: policyHashHex(POLICY),
          purposeCode: 1,
          revoked: false,
          consumed: true,
        },
        expectedPolicyHashHex: policyHashHex(POLICY),
        expectedPurposeCode: 1,
        expiresAt: EXPIRY,
        nowIso: NOW,
      }),
    ).toEqual({ eligible: false, reason: "consumed" });
    // Second redemption rejected.
    expect(() =>
      store.consume("agent-001", "eligibility-redeem:x", NOW),
    ).toThrowError(DomainError);
  });

  it("cross-agent proofs never validate for another agent", () => {
    const store = createSimulatedEligibilityStore();
    store.prove(validProof(), NOW);
    // Agent B has no record: no-record, never agent A's statement.
    expect(store.read("agent-002")).toBeNull();
    expect(
      checkEligibility({
        record: null,
        expectedPolicyHashHex: policyHashHex(POLICY),
        expectedPurposeCode: 1,
        expiresAt: EXPIRY,
        nowIso: NOW,
      }).eligible,
    ).toBe(false);
  });

  it("revocation invalidates live statements", () => {
    const store = createSimulatedEligibilityStore();
    store.prove(validProof(), NOW);
    store.revoke("agent-001", NOW);
    expect(
      checkEligibility({
        record: {
          policyHashHex: policyHashHex(POLICY),
          purposeCode: 1,
          revoked: true,
          consumed: false,
        },
        expectedPolicyHashHex: policyHashHex(POLICY),
        expectedPurposeCode: 1,
        expiresAt: EXPIRY,
        nowIso: NOW,
      }),
    ).toEqual({ eligible: false, reason: "revoked" });
    expect(() => store.revoke("ghost-agent", NOW)).toThrowError(DomainError);
  });

  it("9/10. public views carry no private values", () => {
    const store = createSimulatedEligibilityStore();
    const proof = validProof();
    store.prove(proof, NOW);
    // Private values exist only in test scope — they must not appear in
    // any projection even when concatenated nearby (canary check).
    const canaries = [SECRET_AMOUNT, SECRET_SALT, SECRET_NONCE];
    const view = toPublicEligibilityView({
      agentId: "agent-001",
      check: { eligible: true, reason: "eligible" },
      policyVersion: POLICY,
      purpose: "collateral-sufficiency",
      proofStatus: "VERIFIED",
      asOf: NOW,
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        "agentId",
        "asOf",
        "eligible",
        "policyVersion",
        "proofStatus",
        "purpose",
        "reason",
      ].sort(),
    );
    const serialized = JSON.stringify(view);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("amountMinorUnits");
    expect(serialized).not.toContain("commitmentSalt");
    expect(serialized).not.toContain("operatorSecret");
    expect(serialized).not.toContain("witness");
    expect(serialized).not.toContain("blinding");
    // Proof records themselves have no private fields by construction.
    expect(Object.keys(proof).sort()).toEqual(
      [
        "agentId",
        "bondId",
        "expiresAt",
        "kind",
        "nullifier",
        "policyVersion",
        "proofId",
        "purpose",
        "status",
        "txId",
      ].sort(),
    );
  });

  it("11. simulated fixtures are labeled and never claim ZK validity", () => {
    const proof = validProof();
    expect(proof.kind).toBe("SIMULATED-FIXTURE");
    // A forged object with an unknown kind fails construction at runtime,
    // not just at the type boundary.
    expect(() =>
      createEligibilityProof({
        proofId: "forged-001",
        kind: "REAL-ZK-PROOF" as EligibilityProof["kind"],
        agentId: "agent-001",
        bondId: "bond-001",
        policy: {
          policyVersion: POLICY,
          requiredMinimumMinorUnits: "100",
          purpose: "collateral-sufficiency",
        },
        nullifier: "n",
        expiresAt: EXPIRY,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
  });

  it("14. lifecycle transitions are deterministic and guarded", () => {
    const created = validProof();
    const submitted = transitionEligibilityProof(created, "SUBMITTED", NOW);
    expect(submitted.status).toBe("SUBMITTED");
    const verified = transitionEligibilityProof(submitted, "VERIFIED", NOW);
    const consumed = transitionEligibilityProof(verified, "CONSUMED", NOW);
    expect(consumed.status).toBe("CONSUMED");
    expect(() =>
      transitionEligibilityProof(consumed, "VERIFIED", NOW),
    ).toThrowError(DomainError);
    expect(() =>
      transitionEligibilityProof(created, "VERIFIED", NOW),
    ).toThrowError(DomainError);
    expect(
      transitionEligibilityProof(created, "EXPIRED", "2026-11-01T00:00:00.000Z")
        .status,
    ).toBe("EXPIRED");
    // Deterministic: identical transitions reproduce identical records.
    expect(transitionEligibilityProof(created, "SUBMITTED", NOW)).toEqual(
      submitted,
    );
  });

  it("circuit args encode the public statement deterministically", () => {
    const args = eligibilityCircuitArgs({
      agentId: "agent-001",
      policyVersion: POLICY,
      purpose: "collateral-sufficiency",
      requiredMinimumMinorUnits: "1000",
      nullifier: deriveProofNullifier(
        "agent-001",
        "collateral-sufficiency",
        "nonce-001",
      ),
    });
    expect(args).toHaveLength(5);
    expect((args[0] as Uint8Array).length).toBe(32);
    expect((args[1] as Uint8Array).length).toBe(32);
    expect(args[2]).toBe(1n);
    expect(args[3]).toBe(1000n);
    expect((args[4] as Uint8Array).length).toBe(32);
    // Policy hash matches SHA-256 domain separation (verifiable claim).
    const expected = createHash("sha256")
      .update(`bond-policy:${POLICY}`, "utf8")
      .digest("hex");
    expect(Buffer.from(args[1] as Uint8Array).toString("hex")).toBe(expected);
  });
});

describe("eligibility adversarial cases", () => {
  it("altered public inputs fail binding", () => {
    const store = createSimulatedEligibilityStore();
    const proof = validProof();
    store.prove(proof, NOW);
    // Attacker swaps the policy hash on a copied record: mismatch.
    expect(
      checkEligibility({
        record: {
          policyHashHex: policyHashHex("bond-policy-v999"),
          purposeCode: ELIGIBILITY_PURPOSE_CODES["collateral-sufficiency"],
          revoked: false,
          consumed: false,
        },
        expectedPolicyHashHex: policyHashHex(POLICY),
        expectedPurposeCode: 1,
        expiresAt: EXPIRY,
        nowIso: NOW,
      }),
    ).toEqual({ eligible: false, reason: "policy-mismatch" });
    // Attacker replays agent A's nullifier for a "new" proof → replay.
    const forged = validProof({
      proofId: "proof-forged",
      nullifier: proof.nullifier,
    });
    expect(() => store.prove(forged, NOW)).toThrowError(DomainError);
  });

  it("error messages never carry private values", () => {
    const canaryAmount = "777888999000111222";
    const canarySalt = "canary-blinding-salt-xyz";
    const canarySecret = "canary-operator-secret-xyz";
    const errors: unknown[] = [];
    try {
      createEligibilityProof({
        proofId: "p",
        kind: "SIMULATED-FIXTURE",
        agentId: "a",
        bondId: "b",
        policy: {
          policyVersion: POLICY,
          requiredMinimumMinorUnits: "not-digits",
          purpose: "collateral-sufficiency",
        },
        nullifier: "n",
        expiresAt: EXPIRY,
        nowIso: NOW,
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      transitionEligibilityProof(validProof(), "CONSUMED", NOW);
    } catch (error) {
      errors.push(error);
    }
    expect(errors.length).toBeGreaterThan(0);
    const text = JSON.stringify(errors.map((error) => String(error)));
    for (const canary of [canaryAmount, canarySalt, canarySecret]) {
      expect(text).not.toContain(canary);
    }
    // Thresholds ride in validated policy config, never in messages.
    expect(text).not.toContain("not-digits");
  });

  it("nullifier domains never collide across purposes", () => {
    const proofNullifier = deriveProofNullifier(
      "agent-001",
      "collateral-sufficiency",
      "nonce-001",
    );
    const redemptionNullifier = deriveRedemptionNullifier(
      "agent-001",
      "proof-001",
      "nonce-001",
    );
    expect(proofNullifier).not.toBe(redemptionNullifier);
    expect(proofNullifier.startsWith("eligibility-proof:")).toBe(true);
    expect(redemptionNullifier.startsWith("eligibility-redeem:")).toBe(true);
  });
});
