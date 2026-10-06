import { describe, expect, it } from "vitest";
import {
  createAttestationRequest,
  createRiskFlag,
  issueDecision,
  parseAgentId,
  parseAttestationId,
  parseDecisionId,
  parseEvidenceId,
  parseRiskFlagId,
  recordVerdict,
  parseAttestorId,
} from "@bond/shared-types";
import { MidnightError } from "./errors.js";
import { resolveMidnightConfig } from "./config.js";
import {
  buildBondLockRequest,
  buildEnforcementRequest,
  buildRegistrationRequest,
  buildWithdrawalRequest,
} from "./requests.js";
import {
  agentLifecycleOp,
  confirmOperation,
  connectMidnight,
  enforcementCircuitArgs,
  lockBondOp,
  processEnforcementOp,
  readEligibilityRecord,
  readPublicState,
  registerAgentOp,
  releaseBondOp,
  submitEligibilityProof,
  submitEligibilityRevocation,
  submitRealCall,
  withdrawBondOp,
} from "./client.js";

const NOW = "2026-10-02T00:00:00.000Z";

function simHandle() {
  return connectMidnight(resolveMidnightConfig({}));
}

function decidedAttestation() {
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

function flag() {
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

function enforcementRequest() {
  return buildEnforcementRequest({
    bondId: "bond-001",
    attestation: decidedAttestation(),
    flag: flag(),
    amountMinorUnits: "2500",
    nowIso: NOW,
  });
}

describe("SIMULATED chain operations", () => {
  it("walks the full lifecycle with labeled receipts", () => {
    const handle = simHandle();
    const op = "op-001";
    expect(
      registerAgentOp(
        handle,
        buildRegistrationRequest({ agentId: "agent-001", operatorId: op }),
      ).status,
    ).toBe("SUBMITTED");
    const lock = lockBondOp(
      handle,
      buildBondLockRequest({
        bondId: "bond-001",
        agentId: "agent-001",
        operatorId: op,
        commitmentMinorUnits: "10000",
      }),
    );
    expect(lock.status).toBe("SUBMITTED");
    expect(lock.mode).toBe("SIMULATED");
    expect(lock.txId.startsWith("sim-")).toBe(true);
    expect(
      agentLifecycleOp(handle, "activate", {
        agentId: "agent-001",
        operatorId: op,
      }).status,
    ).toBe("SUBMITTED");
    expect(
      agentLifecycleOp(handle, "flag", { agentId: "agent-001", operatorId: op })
        .status,
    ).toBe("SUBMITTED");
    const slash = processEnforcementOp(handle, enforcementRequest(), NOW);
    expect(slash.status).toBe("SUBMITTED");
    expect(slash.ledger?.bonds["bond-001"].status).toBe("PARTIALLY_SLASHED");
    expect(
      agentLifecycleOp(handle, "resolve", {
        agentId: "agent-001",
        operatorId: op,
      }).status,
    ).toBe("SUBMITTED");
    // SIMULATED receipts are never CONFIRMED here — confirmation is a
    // chain-finality concept, meaningless without a chain.
    for (const result of [lock, slash]) {
      expect(result.status).not.toBe("CONFIRMED");
    }
  });

  it("fails closed with structured codes and deterministic tx ids", () => {
    const handle = simHandle();
    const first = registerAgentOp(
      handle,
      buildRegistrationRequest({ agentId: "agent-001", operatorId: "op-001" }),
    );
    expect(first.status).toBe("SUBMITTED");
    const replay = registerAgentOp(
      handle,
      buildRegistrationRequest({ agentId: "agent-001", operatorId: "op-001" }),
    );
    expect(replay.status).toBe("FAILED");
    expect(replay.errorCode).toBe("INVALID_AGENT_TRANSITION");
    expect(replay.txId.startsWith("sim-failed-")).toBe(true);
    // Deterministic: identical failing input reproduces the same receipt.
    const replay2 = registerAgentOp(
      handle,
      buildRegistrationRequest({ agentId: "agent-001", operatorId: "op-001" }),
    );
    expect(replay2.txId).toBe(replay.txId);
    expect(first.txId).not.toBe(replay.txId);
  });

  it("reads SIMULATED public state without private values", async () => {
    const handle = simHandle();
    registerAgentOp(
      handle,
      buildRegistrationRequest({ agentId: "agent-001", operatorId: "op-001" }),
    );
    const views = await readPublicState(handle, { agentIds: ["agent-001"] });
    expect(views).toEqual([
      {
        agentId: "agent-001",
        status: "REGISTERED",
        bondStatus: null,
        slashCount: 0,
      },
    ]);
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain("op-001");
    expect(await readPublicState(handle, { agentIds: ["ghost"] })).toEqual([]);
  });

  it("releases and withdraws through the SIMULATED lifecycle", () => {
    const handle = simHandle();
    const op = "op-001";
    registerAgentOp(
      handle,
      buildRegistrationRequest({ agentId: "agent-001", operatorId: op }),
    );
    lockBondOp(
      handle,
      buildBondLockRequest({
        bondId: "bond-001",
        agentId: "agent-001",
        operatorId: op,
        commitmentMinorUnits: "10000",
      }),
    );
    expect(
      releaseBondOp(handle, { bondId: "bond-001", operatorId: op }).status,
    ).toBe("SUBMITTED");
    const withdrawn = withdrawBondOp(
      handle,
      buildWithdrawalRequest({ bondId: "bond-001", operatorId: op }),
    );
    expect(withdrawn.status).toBe("SUBMITTED");
    expect(withdrawn.ledger?.bonds["bond-001"].status).toBe("WITHDRAWN");
    const double = withdrawBondOp(
      handle,
      buildWithdrawalRequest({ bondId: "bond-001", operatorId: op }),
    );
    expect(double.status).toBe("FAILED");
  });
});

describe("REAL guards (no network)", () => {
  it("refuses REAL work without wallet or providers — never fakes success", async () => {
    const real = resolveMidnightConfig({ MIDNIGHT_NETWORK: "undeployed" });
    expect(() => connectMidnight(real)).toThrowError(MidnightError);
    const off = resolveMidnightConfig({ MIDNIGHT_NETWORK: "off" });
    expect(() => connectMidnight(off)).toThrowError(
      /disabled by configuration/,
    );
    const handle = simHandle();
    await expect(
      submitRealCall(handle, {
        circuitId: "registerAgent",
        args: [],
        privateState: {
          operatorSecret: new Uint8Array(32),
          commitmentAmount: 0n,
          commitmentSalt: new Uint8Array(32),
        },
      }),
    ).rejects.toThrowError(MidnightError);
    await expect(confirmOperation(handle, "tx-123")).rejects.toThrowError(
      MidnightError,
    );
  });

  it("encodes REAL circuit args from validated requests", () => {
    const args = enforcementCircuitArgs({
      agentId: "agent-001",
      bondId: "bond-001",
      nullifier: "nullifier-001",
      action: "partial-slash",
      amountMinorUnits: "2500",
    });
    expect(args).toHaveLength(5);
    expect((args[0] as Uint8Array).length).toBe(32);
    expect(args[3]).toBe(1n);
    expect(args[4]).toBe(2500n);
    expect(
      enforcementCircuitArgs({
        agentId: "agent-001",
        bondId: "bond-001",
        nullifier: "nullifier-001",
        action: "full-slash",
        amountMinorUnits: "10000",
      })[3],
    ).toBe(2n);
  });
});

describe("eligibility REAL guards (no network)", () => {
  it("refuses eligibility submission without REAL providers", async () => {
    const handle = simHandle();
    const privateState = {
      operatorSecret: new Uint8Array(32),
      commitmentAmount: 10000n,
      commitmentSalt: new Uint8Array(32),
    };
    await expect(
      submitEligibilityProof(handle, {
        agentId: "agent-001",
        policyVersion: "bond-policy-v1",
        purposeCode: 1,
        requiredMinimumMinorUnits: "1000",
        nullifier: "eligibility-proof:agent-001:collateral-sufficiency:n1",
        privateState,
      }),
    ).rejects.toThrowError(MidnightError);
    await expect(
      submitEligibilityRevocation(handle, {
        agentId: "agent-001",
        privateState,
      }),
    ).rejects.toThrowError(MidnightError);
    await expect(
      readEligibilityRecord(handle, "agent-001"),
    ).rejects.toThrowError(MidnightError);
  });
});
