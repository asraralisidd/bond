/**
 * Adapter + toolchain version identifiers.
 *
 * TOOLCHAIN STATUS (verified 2026-10-06, see docs/phase-4):
 * - No Compact compiler binary installed locally (no `compact`/`compactc`).
 * - No Midnight packages installed locally.
 * - npm registry reachable; @midnight-ntwrk/midnight-js-contracts latest
 *   observed at 4.1.1 (NOT installed, NOT integrated — adoption is Phase 5
 *   work once the compiler is available to verify generated modules).
 */
export const ADAPTER_VERSION = "adapter-v1" as const;

/** Version of the contract rule model this adapter targets. */
export const TARGET_CONTRACT_VERSION = "bond-contract-v1" as const;
export const TARGET_POLICY_VERSION = "bond-policy-v1" as const;
