/**
 * Live E2E test harness (Phase 14).
 *
 * Explicit gate: `BOND_E2E_LIVE=1`. Without it, live tests skip cleanly
 * and the default suite never touches a network. With it, missing
 * infrastructure fails LOUDLY — the harness never falls back to
 * SIMULATED. REAL mode is asserted on every path that claims it.
 *
 * No submission happens through this harness: live tests are read-only
 * (contract reachability, finality reads). Submission tests would
 * additionally require a funded wallet and must use unique idempotency
 * keys per run.
 */
import {
  resolveMidnightConfig,
  type MidnightConfig,
} from "@bond/midnight-adapter";

export function isLiveE2EEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.BOND_E2E_LIVE === "1";
}

export interface LivePrerequisites {
  readonly config: MidnightConfig;
  readonly network: string;
  readonly contractAddress: string;
}

/**
 * Validates live-test prerequisites. Throws (fail loudly) when the gate
 * is on but anything is missing or not REAL. Never returns a SIMULATED
 * config — callers must not proceed on anything else.
 */
export function requireLivePrerequisites(
  env: NodeJS.ProcessEnv = process.env,
): LivePrerequisites {
  if (!isLiveE2EEnabled(env)) {
    throw new Error(
      "BOND_E2E_LIVE is not enabled; live tests must skip, not run",
    );
  }
  const config = resolveMidnightConfig(env);
  if (config.mode !== "REAL" || config.endpoints === null) {
    throw new Error(
      `Live E2E requires REAL Midnight configuration, got mode=${config.mode}. ` +
        "Refusing to fall back to SIMULATED.",
    );
  }
  const contractAddress = (env.BOND_CONTRACT_ADDRESS ?? "").trim();
  if (!contractAddress) {
    throw new Error(
      "Live E2E requires BOND_CONTRACT_ADDRESS to be set to a deployed contract.",
    );
  }
  return {
    config,
    network: config.endpoints.networkId,
    contractAddress,
  };
}
