/**
 * Witness callbacks for the BOND circuits (state-reader style).
 *
 * Each callback reads its opening from the call's private state
 * (`context.privateState`), which the caller stores via the private-state
 * provider before invoking a circuit. Private state NEVER leaves the
 * operator's runtime: these callbacks only supply openings to the local
 * prover during proof generation. The adapter stores no secrets — values
 * are held in memory by the caller, per call.
 */
import type { Witnesses } from "../../../contracts/managed/bond/contract/index.js";

export interface BondPrivateState {
  readonly operatorSecret: Uint8Array;
  readonly commitmentAmount: bigint;
  readonly commitmentSalt: Uint8Array;
}

export function createBondPrivateState(input: {
  readonly operatorSecret: Uint8Array;
  readonly commitmentAmount?: bigint;
  readonly commitmentSalt?: Uint8Array;
}): BondPrivateState {
  if (input.operatorSecret.length !== 32) {
    throw new Error("operatorSecret must be 32 bytes");
  }
  return {
    operatorSecret: input.operatorSecret,
    commitmentAmount: input.commitmentAmount ?? 0n,
    commitmentSalt: input.commitmentSalt ?? new Uint8Array(32),
  };
}

export const BOND_PRIVATE_STATE_ID = "bondPrivateState" as const;
export type BondPrivateStateId = typeof BOND_PRIVATE_STATE_ID;

/** Static readers: values come from per-call private state. */
export const bondWitnesses: Witnesses<BondPrivateState> = {
  operatorSecret: ({ privateState }) => [
    privateState,
    privateState.operatorSecret,
  ],
  commitmentAmount: ({ privateState }) => [
    privateState,
    privateState.commitmentAmount,
  ],
  commitmentSalt: ({ privateState }) => [
    privateState,
    privateState.commitmentSalt,
  ],
};
