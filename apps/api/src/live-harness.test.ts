/**
 * Live harness unit tests (Phase 14) — fully offline-safe, part of the
 * default suite. Proves the gate, the fail-loud prerequisites, REAL/SIM
 * separation, and the eligibility dry-run construction without touching
 * any network.
 */
import { describe, expect, it } from "vitest";
import {
  buildReadOnlyProviders,
  connectReadOnly,
  eligibilityProofCircuitArgs,
} from "@bond/midnight-adapter";
import {
  isLiveE2EEnabled,
  requireLivePrerequisites,
} from "./services/live-e2e.js";

function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("live E2E gate", () => {
  it("is disabled unless BOND_E2E_LIVE is exactly 1", () => {
    expect(isLiveE2EEnabled(env({}))).toBe(false);
    expect(isLiveE2EEnabled(env({ BOND_E2E_LIVE: "" }))).toBe(false);
    expect(isLiveE2EEnabled(env({ BOND_E2E_LIVE: "0" }))).toBe(false);
    expect(isLiveE2EEnabled(env({ BOND_E2E_LIVE: "true" }))).toBe(false);
    expect(isLiveE2EEnabled(env({ BOND_E2E_LIVE: "1" }))).toBe(true);
  });
});

describe("live prerequisites fail loudly", () => {
  it("refuses without the gate", () => {
    expect(() => requireLivePrerequisites(env({}))).toThrowError(/not enabled/);
  });

  it("never falls back to SIMULATED when the gate is on", () => {
    expect(() =>
      requireLivePrerequisites(env({ BOND_E2E_LIVE: "1" })),
    ).toThrowError(/SIMULATED/);
    expect(() =>
      requireLivePrerequisites(
        env({ BOND_E2E_LIVE: "1", MIDNIGHT_NETWORK: "simulated" }),
      ),
    ).toThrowError(/SIMULATED/);
  });

  it("requires a deployed contract address", () => {
    expect(() =>
      requireLivePrerequisites(
        env({ BOND_E2E_LIVE: "1", MIDNIGHT_NETWORK: "undeployed" }),
      ),
    ).toThrowError(/BOND_CONTRACT_ADDRESS/);
  });

  it("returns REAL prerequisites when fully configured", () => {
    const prereqs = requireLivePrerequisites(
      env({
        BOND_E2E_LIVE: "1",
        MIDNIGHT_NETWORK: "undeployed",
        BOND_CONTRACT_ADDRESS: "addr-test-123",
      }),
    );
    expect(prereqs.config.mode).toBe("REAL");
    expect(prereqs.network).toBe("undeployed");
    expect(prereqs.contractAddress).toBe("addr-test-123");
  });

  it("rejects unknown networks loudly", () => {
    expect(() =>
      requireLivePrerequisites(
        env({
          BOND_E2E_LIVE: "1",
          MIDNIGHT_NETWORK: "mainnet",
          BOND_CONTRACT_ADDRESS: "addr-test-123",
        }),
      ),
    ).toThrowError(/not enabled|Unknown|not enabled/);
  });
});

describe("eligibility dry-run construction (offline)", () => {
  it("builds five deterministic circuit args", () => {
    const input = {
      agentId: "agent-dry-1",
      policyVersion: "bond-policy-v1",
      purposeCode: 1,
      requiredMinimumMinorUnits: "1000",
      nullifier: "nullifier-dry-1",
    };
    const first = eligibilityProofCircuitArgs(input);
    expect(first).toHaveLength(5);
    expect(eligibilityProofCircuitArgs(input)).toEqual(first);
  });

  it("rejects malformed amounts before any network use", () => {
    expect(() =>
      eligibilityProofCircuitArgs({
        agentId: "agent-dry-1",
        policyVersion: "bond-policy-v1",
        purposeCode: 1,
        requiredMinimumMinorUnits: "not-a-number",
        nullifier: "nullifier-dry-1",
      }),
    ).toThrowError();
  });
});

describe("read-only provider assembly fail-closed", () => {
  it("refuses null endpoints", () => {
    expect(() =>
      buildReadOnlyProviders(
        {
          mode: "SIMULATED",
          endpoints: null,
          contractAddress: null,
          zkAssetsPath: "",
        },
        "",
      ),
    ).toThrowError(/endpoints/i);
  });

  it("connectReadOnly refuses SIMULATED configuration", () => {
    expect(() =>
      connectReadOnly({
        mode: "SIMULATED",
        endpoints: null,
        contractAddress: null,
        zkAssetsPath: "",
      }),
    ).toThrowError(/REAL/);
  });
});
