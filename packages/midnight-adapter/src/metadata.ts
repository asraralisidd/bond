/**
 * Contract metadata: the adapter's declared target.
 *
 * These are ADAPTER contracts (local boundary types), not generated
 * blockchain types — no compiler output exists yet to generate from.
 * Marked as such so nothing downstream mistakes them for on-chain truth.
 */
import {
  ADAPTER_VERSION,
  TARGET_CONTRACT_VERSION,
  TARGET_POLICY_VERSION,
} from "./versions.js";

export type ToolchainStatus = "unverified-toolchain";

export interface ToolchainInfo {
  readonly status: ToolchainStatus;
  /** Latest versions OBSERVED (registry), explicitly not integrated. */
  readonly observedMidnightJsContracts: string;
  readonly observedProofProvider: string;
  readonly observedAt: string;
  readonly compactCompiler: "not-installed";
}

export interface ContractMetadata {
  readonly contractName: "bond-enforcement";
  readonly contractVersion: typeof TARGET_CONTRACT_VERSION;
  readonly policyVersion: typeof TARGET_POLICY_VERSION;
  readonly adapterVersion: typeof ADAPTER_VERSION;
  readonly toolchain: ToolchainInfo;
}

export const TOOLCHAIN_INFO: ToolchainInfo = {
  status: "unverified-toolchain",
  observedMidnightJsContracts: "4.1.1",
  observedProofProvider: "4.1.1",
  observedAt: "2026-10-06",
  compactCompiler: "not-installed",
};

export const BOND_CONTRACT_METADATA: ContractMetadata = {
  contractName: "bond-enforcement",
  contractVersion: TARGET_CONTRACT_VERSION,
  policyVersion: TARGET_POLICY_VERSION,
  adapterVersion: ADAPTER_VERSION,
  toolchain: TOOLCHAIN_INFO,
};
