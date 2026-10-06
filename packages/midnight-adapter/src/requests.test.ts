import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import {
  createAttestationRequest,
  createRiskFlag,
  issueDecision,
  parseAgentId,
  parseAttestationId,
  parseAttestorId,
  parseDecisionId,
  parseEvidenceId,
  parseRiskFlagId,
  recordVerdict,
} from "@bond/shared-types";
import type { Attestation, RiskFlag } from "@bond/shared-types";
import {
  buildBondLockRequest,
  buildEnforcementRequest,
  buildRegistrationRequest,
  buildWithdrawalRequest,
} from "./requests.js";
import { BOND_CONTRACT_METADATA } from "./metadata.js";

const NOW = "2026-10-02T00:00:00.000Z";

function flag(): RiskFlag {
  return createRiskFlag({
    riskFlagId: parseRiskFlagId("flag-001"),
    agentId: parseAgentId("agent-001"),
    category: "unauthorized-action",
    severity: "high",
    confidence: 0.9,
    evidenceRefs: [
      {
        evidenceId: parseEvidenceId("ev-001"),
        category: "tool-call-log",
        contentHash: "bond-risk-digest:aaaa1111",
      },
    ],
    detectedAt: "2026-10-01T12:00:00.000Z",
    modelVersion: "test-scorer/v1",
  });
}

function decidedAttestation(): Attestation {
  let attestation = createAttestationRequest({
    attestationId: parseAttestationId("att-001"),
    riskFlagId: parseRiskFlagId("flag-001"),
    agentId: parseAgentId("agent-001"),
    evidenceRefs: [parseEvidenceId("ev-001")],
    policyVersion: "bond-policy-v1",
    threshold: 2,
    requestedAt: "2026-10-01T13:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
  });
  for (const id of ["attestor-a", "attestor-b"]) {
    attestation = recordVerdict(attestation, {
      attestorId: parseAttestorId(id),
      verdict: "confirm",
      bindingRef: `binding:att-001:${id}`,
      issuedAt: "2026-10-02T00:00:00.000Z",
    });
  }
  return issueDecision(attestation, {
    decisionId: parseDecisionId("dec-001"),
    action: "partial-slash",
    nullifier: "nullifier-001",
    decisionExpiresAt: "2026-10-09T00:00:00.000Z",
    nowIso: NOW,
  });
}

describe("adapter request builders", () => {
  it("builds registration, bond-lock, and withdrawal intents", () => {
    expect(
      buildRegistrationRequest({ agentId: "agent-001", operatorId: "op-001" }),
    ).toEqual({
      kind: "register-agent",
      agentId: "agent-001",
      operatorId: "op-001",
    });
    expect(() =>
      buildRegistrationRequest({ agentId: "", operatorId: "op-001" }),
    ).toThrowError(DomainError);
    expect(
      buildBondLockRequest({
        bondId: "bond-001",
        agentId: "agent-001",
        operatorId: "op-001",
        commitmentMinorUnits: "10000",
      }).kind,
    ).toBe("lock-bond");
    expect(() =>
      buildBondLockRequest({
        bondId: "bond-001",
        agentId: "agent-001",
        operatorId: "op-001",
        commitmentMinorUnits: "10.5",
      }),
    ).toThrowError(DomainError);
    expect(
      buildWithdrawalRequest({ bondId: "bond-001", operatorId: "op-001" }),
    ).toEqual({
      kind: "withdraw-bond",
      bondId: "bond-001",
      operatorId: "op-001",
    });
  });

  it("builds enforcement intents only from decided, fresh, bound attestations", () => {
    const request = buildEnforcementRequest({
      bondId: "bond-001",
      attestation: decidedAttestation(),
      flag: flag(),
      amountMinorUnits: "2500",
      nowIso: NOW,
    });
    expect(request.kind).toBe("process-enforcement");
    expect(request.decision).toMatchObject({
      decisionId: "dec-001",
      action: "partial-slash",
      nullifier: "nullifier-001",
      agentId: "agent-001",
      riskFlagId: "flag-001",
      amountMinorUnits: "2500",
    });
    // Expired decision rejected.
    expect(() =>
      buildEnforcementRequest({
        bondId: "bond-001",
        attestation: decidedAttestation(),
        flag: flag(),
        amountMinorUnits: "2500",
        nowIso: "2026-11-01T00:00:00.000Z",
      }),
    ).toThrowError(DomainError);
    // Subject mismatch rejected.
    const otherFlag = createRiskFlag({
      riskFlagId: parseRiskFlagId("flag-002"),
      agentId: parseAgentId("agent-002"),
      category: "overspend",
      severity: "medium",
      confidence: 0.8,
      evidenceRefs: [
        {
          evidenceId: parseEvidenceId("ev-002"),
          category: "transaction-record",
          contentHash: "bond-risk-digest:bbbb2222",
        },
      ],
      detectedAt: "2026-10-01T12:00:00.000Z",
      modelVersion: "test-scorer/v1",
    });
    expect(() =>
      buildEnforcementRequest({
        bondId: "bond-001",
        attestation: decidedAttestation(),
        flag: otherFlag,
        amountMinorUnits: "2500",
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
    // Partial without amount rejected.
    expect(() =>
      buildEnforcementRequest({
        bondId: "bond-001",
        attestation: decidedAttestation(),
        flag: flag(),
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
  });

  it("exposes versioned contract metadata with verified toolchain status", () => {
    expect(BOND_CONTRACT_METADATA.contractName).toBe("bond-enforcement");
    expect(BOND_CONTRACT_METADATA.contractVersion).toBe("bond-contract-v1");
    expect(BOND_CONTRACT_METADATA.adapterVersion).toBe("adapter-v2");
    expect(BOND_CONTRACT_METADATA.toolchain.status).toBe("verified-toolchain");
    expect(BOND_CONTRACT_METADATA.toolchain.toolchain.compactCompiler).toBe(
      "0.31.1",
    );
    expect(BOND_CONTRACT_METADATA.toolchain.managedDir).toBe(
      "contracts/managed/bond",
    );
  });
});
