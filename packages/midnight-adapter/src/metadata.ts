/**
 * Contract metadata: the adapter's declared target.
 *
 * Toolchain is now VERIFIED (compiled locally with compiler 0.31.1);
 * generated bindings are consumed, never pretended.
 */
import {
  ADAPTER_VERSION,
  TARGET_CONTRACT_VERSION,
  TARGET_POLICY_VERSION,
  VERIFIED_TOOLCHAIN,
} from "./versions.js";
import type { VerifiedToolchain } from "./versions.js";

export type ToolchainStatus = "verified-toolchain";

export interface ToolchainInfo {
  readonly status: ToolchainStatus;
  readonly toolchain: VerifiedToolchain;
  /** `contracts/managed/bond` output of the verified compile. */
  readonly managedDir: "contracts/managed/bond";
}

export interface ContractMetadata {
  readonly contractName: "bond-enforcement";
  readonly contractVersion: typeof TARGET_CONTRACT_VERSION;
  readonly policyVersion: typeof TARGET_POLICY_VERSION;
  readonly adapterVersion: typeof ADAPTER_VERSION;
  readonly toolchain: ToolchainInfo;
}

export const TOOLCHAIN_INFO: ToolchainInfo = {
  status: "verified-toolchain",
  toolchain: VERIFIED_TOOLCHAIN,
  managedDir: "contracts/managed/bond",
};

export const BOND_CONTRACT_METADATA: ContractMetadata = {
  contractName: "bond-enforcement",
  contractVersion: TARGET_CONTRACT_VERSION,
  policyVersion: TARGET_POLICY_VERSION,
  adapterVersion: ADAPTER_VERSION,
  toolchain: TOOLCHAIN_INFO,
};
