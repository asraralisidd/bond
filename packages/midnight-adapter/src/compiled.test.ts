import { describe, expect, it } from "vitest";
import {
  BOND_PRIVATE_STATE_ID,
  bondWitnesses,
  createBondPrivateState,
} from "./witnesses.js";
import { makeBondCompiledContract } from "./compiled.js";

const SECRET = new Uint8Array(32).fill(7);

describe("witnesses and compiled contract", () => {
  it("validates private-state shape and reads openings back", () => {
    expect(() =>
      createBondPrivateState({ operatorSecret: new Uint8Array(16) }),
    ).toThrowError(/32 bytes/);
    const state = createBondPrivateState({
      operatorSecret: SECRET,
      commitmentAmount: 10000n,
      commitmentSalt: new Uint8Array(32).fill(9),
    });
    const ctx = { privateState: state } as never;
    expect(bondWitnesses.operatorSecret(ctx)[1]).toBe(SECRET);
    expect(bondWitnesses.commitmentAmount(ctx)[1]).toBe(10000n);
    expect(BOND_PRIVATE_STATE_ID).toBe("bondPrivateState");
  });

  it("builds the compiled contract from VERIFIED artifacts", () => {
    // Proves the generated module + ZK file assets load together.
    const compiled = makeBondCompiledContract();
    expect(compiled).toBeDefined();
  });
});
