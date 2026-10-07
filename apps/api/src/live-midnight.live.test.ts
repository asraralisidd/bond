/**
 * Live Midnight E2E tests — READ-ONLY, explicitly gated.
 *
 * Gate: `BOND_E2E_LIVE=1`. Without the gate every test in this file
 * SKIPS (never touches a network, never falls back to SIMULATED).
 * With the gate, `requireLivePrerequisites` fails loudly if REAL
 * configuration, a deployed contract address, or reachable endpoints
 * are missing.
 *
 * These tests SUBMIT nothing: they prove provider assembly, REAL mode
 * selection, and contract reachability against live infrastructure.
 * Submission/finality execution requires a funded wallet and remains
 * BLOCKED / NOT VERIFIED.
 *
 * Run explicitly: `BOND_E2E_LIVE=1 npx vitest run live-midnight`
 * (or `npm run test:live`). Never part of default CI.
 */
import { describe, expect, it } from "vitest";
import {
  connectReadOnly,
  eligibilityProofCircuitArgs,
  findBondContract,
} from "@bond/midnight-adapter";
import {
  isLiveE2EEnabled,
  requireLivePrerequisites,
} from "./services/live-e2e.js";

const LIVE = isLiveE2EEnabled();

describe.skipIf(!LIVE)("live gate", () => {
  it("resolves REAL configuration without SIMULATED fallback", () => {
    const prereqs = requireLivePrerequisites();
    expect(prereqs.config.mode).toBe("REAL");
    expect(prereqs.config.endpoints).not.toBeNull();
    expect(prereqs.contractAddress.length).toBeGreaterThan(0);
  });

  it("assembles read-only providers and reaches the deployed contract", async () => {
    const prereqs = requireLivePrerequisites();
    const handle = connectReadOnly(prereqs.config);
    expect(handle.mode).toBe("REAL");
    expect(handle.providers).not.toBeNull();
    const found = await findBondContract(handle, prereqs.contractAddress);
    expect(found.mode).toBe("REAL");
    expect(found.contractAddress).toBe(prereqs.contractAddress);
  });

  it("constructs eligibility circuit args deterministically", () => {
    const args = eligibilityProofCircuitArgs({
      agentId: "agent-live-1",
      policyVersion: "bond-policy-v1",
      purposeCode: 1,
      requiredMinimumMinorUnits: "1000",
      nullifier: "nullifier-live-1",
    });
    expect(args).toHaveLength(5);
    expect(
      eligibilityProofCircuitArgs({
        agentId: "agent-live-1",
        policyVersion: "bond-policy-v1",
        purposeCode: 1,
        requiredMinimumMinorUnits: "1000",
        nullifier: "nullifier-live-1",
      }),
    ).toEqual(args);
  });
});

describe("live harness gate (offline-safe)", () => {
  it("is disabled without BOND_E2E_LIVE=1", () => {
    expect(isLiveE2EEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isLiveE2EEnabled({ BOND_E2E_LIVE: "0" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(isLiveE2EEnabled({ BOND_E2E_LIVE: "1" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  it("refuses to run live tests when the gate is absent", () => {
    expect(() =>
      requireLivePrerequisites({} as NodeJS.ProcessEnv),
    ).toThrowError(/not enabled/);
  });
});
