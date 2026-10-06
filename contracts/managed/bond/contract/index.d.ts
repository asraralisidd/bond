import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  operatorSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  commitmentAmount(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  commitmentSalt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  registerAgent(context: __compactRuntime.CircuitContext<PS>,
                agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  lockBond(context: __compactRuntime.CircuitContext<PS>,
           bondId_0: Uint8Array,
           agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  activateAgent(context: __compactRuntime.CircuitContext<PS>,
                agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  flagAgent(context: __compactRuntime.CircuitContext<PS>, agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  resolveAgent(context: __compactRuntime.CircuitContext<PS>,
               agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  reactivateAgent(context: __compactRuntime.CircuitContext<PS>,
                  agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  processEnforcement(context: __compactRuntime.CircuitContext<PS>,
                     agentId_0: Uint8Array,
                     bondId_0: Uint8Array,
                     nullifier_0: Uint8Array,
                     action_0: bigint,
                     amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  releaseBond(context: __compactRuntime.CircuitContext<PS>, bondId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  withdrawBond(context: __compactRuntime.CircuitContext<PS>,
               bondId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveEligibility(context: __compactRuntime.CircuitContext<PS>,
                   agentId_0: Uint8Array,
                   policyHash_0: Uint8Array,
                   purpose_0: bigint,
                   requiredMinimum_0: bigint,
                   nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revokeEligibility(context: __compactRuntime.CircuitContext<PS>,
                    agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  consumeEligibility(context: __compactRuntime.CircuitContext<PS>,
                     agentId_0: Uint8Array,
                     nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  registerAgent(context: __compactRuntime.CircuitContext<PS>,
                agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  lockBond(context: __compactRuntime.CircuitContext<PS>,
           bondId_0: Uint8Array,
           agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  activateAgent(context: __compactRuntime.CircuitContext<PS>,
                agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  flagAgent(context: __compactRuntime.CircuitContext<PS>, agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  resolveAgent(context: __compactRuntime.CircuitContext<PS>,
               agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  reactivateAgent(context: __compactRuntime.CircuitContext<PS>,
                  agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  processEnforcement(context: __compactRuntime.CircuitContext<PS>,
                     agentId_0: Uint8Array,
                     bondId_0: Uint8Array,
                     nullifier_0: Uint8Array,
                     action_0: bigint,
                     amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  releaseBond(context: __compactRuntime.CircuitContext<PS>, bondId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  withdrawBond(context: __compactRuntime.CircuitContext<PS>,
               bondId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveEligibility(context: __compactRuntime.CircuitContext<PS>,
                   agentId_0: Uint8Array,
                   policyHash_0: Uint8Array,
                   purpose_0: bigint,
                   requiredMinimum_0: bigint,
                   nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revokeEligibility(context: __compactRuntime.CircuitContext<PS>,
                    agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  consumeEligibility(context: __compactRuntime.CircuitContext<PS>,
                     agentId_0: Uint8Array,
                     nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  registerAgent(context: __compactRuntime.CircuitContext<PS>,
                agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  lockBond(context: __compactRuntime.CircuitContext<PS>,
           bondId_0: Uint8Array,
           agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  activateAgent(context: __compactRuntime.CircuitContext<PS>,
                agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  flagAgent(context: __compactRuntime.CircuitContext<PS>, agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  resolveAgent(context: __compactRuntime.CircuitContext<PS>,
               agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  reactivateAgent(context: __compactRuntime.CircuitContext<PS>,
                  agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  processEnforcement(context: __compactRuntime.CircuitContext<PS>,
                     agentId_0: Uint8Array,
                     bondId_0: Uint8Array,
                     nullifier_0: Uint8Array,
                     action_0: bigint,
                     amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  releaseBond(context: __compactRuntime.CircuitContext<PS>, bondId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  withdrawBond(context: __compactRuntime.CircuitContext<PS>,
               bondId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveEligibility(context: __compactRuntime.CircuitContext<PS>,
                   agentId_0: Uint8Array,
                   policyHash_0: Uint8Array,
                   purpose_0: bigint,
                   requiredMinimum_0: bigint,
                   nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revokeEligibility(context: __compactRuntime.CircuitContext<PS>,
                    agentId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  consumeEligibility(context: __compactRuntime.CircuitContext<PS>,
                     agentId_0: Uint8Array,
                     nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  agents: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { operatorCommitment: Uint8Array,
                                 bondId: Uint8Array,
                                 hasBond: boolean,
                                 status: bigint,
                                 slashCount: bigint
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { operatorCommitment: Uint8Array,
  bondId: Uint8Array,
  hasBond: boolean,
  status: bigint,
  slashCount: bigint
}]>
  };
  bonds: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { agentId: Uint8Array,
                                 commitment: Uint8Array,
                                 slashedTotal: bigint,
                                 status: bigint,
                                 withdrawn: boolean
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { agentId: Uint8Array,
  commitment: Uint8Array,
  slashedTotal: bigint,
  status: bigint,
  withdrawn: boolean
}]>
  };
  usedNullifiers: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  readonly agentCount: bigint;
  readonly bondCount: bigint;
  eligibility: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { policyHash: Uint8Array,
                                 purpose: bigint,
                                 revoked: boolean,
                                 consumed: boolean
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { policyHash: Uint8Array, purpose: bigint, revoked: boolean, consumed: boolean }]>
  };
  usedEligibilityNullifiers: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
