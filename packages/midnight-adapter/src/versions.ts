/**
 * Adapter + toolchain version identifiers.
 *
 * TOOLCHAIN STATUS (verified live, see docs/phase-5):
 * - compact CLI 0.5.3 at /home/asrar/.local/bin/compact (`compact --version`).
 * - Compact compiler 0.31.1 (`compact compile --version`).
 * - Compact language 0.23.0 / ledger-8.0.2 / runtime 0.16.0 (compiler flags).
 * - midnight-js 4.1.1 family installed (contracts, protocol, network-id,
 *   types, utils); compact-js 2.5.1; compact-runtime 0.16.0 (exact match
 *   for the generated bindings); indexer/http-proof/node-zk-config
 *   providers 4.1.1.
 * - compact-js 2.5.3+ uninstallable here (phantom ledger-v9 alpha dep) —
 *   pinned to verified-installable 2.5.1.
 */
export const ADAPTER_VERSION = "adapter-v2" as const;

/** Version of the contract rule model this adapter targets. */
export const TARGET_CONTRACT_VERSION = "bond-contract-v1" as const;
export const TARGET_POLICY_VERSION = "bond-policy-v1" as const;

export interface VerifiedToolchain {
  readonly compactCli: "0.5.3";
  readonly compactCompiler: "0.31.1";
  readonly compactLanguage: "0.23.0";
  readonly compactLedger: "ledger-8.0.2";
  readonly compactRuntime: "0.16.0";
  readonly midnightJs: "4.1.1";
  readonly compactJs: "2.5.1";
  readonly proofServerImage: "midnightntwrk/proof-server:8.1.0";
}

export const VERIFIED_TOOLCHAIN: VerifiedToolchain = {
  compactCli: "0.5.3",
  compactCompiler: "0.31.1",
  compactLanguage: "0.23.0",
  compactLedger: "ledger-8.0.2",
  compactRuntime: "0.16.0",
  midnightJs: "4.1.1",
  compactJs: "2.5.1",
  proofServerImage: "midnightntwrk/proof-server:8.1.0",
};
