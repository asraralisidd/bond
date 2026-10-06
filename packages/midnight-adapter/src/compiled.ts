/**
 * Compiled-contract wiring: generated module + ZK file assets.
 *
 * Uses the VERIFIED combination: `CompiledContract` from
 * @midnight-ntwrk/compact-js@2.5.1 with witnesses, plus file assets from
 * `contracts/managed/bond` (zkir + proving keys produced by compiler
 * 0.31.1). No invented module shape — types come from the generated
 * `contract/index.d.ts`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { Contract as BondContract } from "../../../contracts/managed/bond/contract/index.js";
import { bondWitnesses } from "./witnesses.js";
import type { BondPrivateState } from "./witnesses.js";

export type BondCircuitId =
  | "registerAgent"
  | "lockBond"
  | "activateAgent"
  | "flagAgent"
  | "resolveAgent"
  | "reactivateAgent"
  | "processEnforcement"
  | "releaseBond"
  | "withdrawBond";

export function defaultBondZkAssetsPath(): string {
  if (process.env.BOND_ZK_ASSETS_PATH) {
    return process.env.BOND_ZK_ASSETS_PATH;
  }
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "contracts",
    "managed",
    "bond",
  );
}

/**
 * Bound compiled contract for Midnight.js deploy/call flows.
 * Witnesses are overridden per call site with call-specific openings.
 */
export function makeBondCompiledContract(
  zkAssetsPath: string = defaultBondZkAssetsPath(),
) {
  return CompiledContract.make("bond", BondContract).pipe(
    CompiledContract.withWitnesses(bondWitnesses as never),
    CompiledContract.withCompiledFileAssets(zkAssetsPath),
  );
}

export type BondCompiledContract = ReturnType<typeof makeBondCompiledContract>;

export type BondPrivateStateShape = BondPrivateState;
