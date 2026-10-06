/**
 * Chain client: BOND operations over SIMULATED or REAL execution.
 *
 * - SIMULATED: the Phase 4 normative rules run in memory. Receipts carry
 *   mode "SIMULATED" and `sim-` tx ids. Explicitly NOT chain activity.
 * - REAL: validated requests submit through Midnight.js
 *   (submitCallTxAsync → SUBMITTED; watchForTxData → CONFIRMED/FAILED).
 *   CONFIRMED is reported only on SucceedEntirely finality — never on
 *   submission. Requires injected wallet + reachable endpoints; anything
 *   missing throws UNAVAILABLE instead of faking success.
 *
 * BOND-level types cross this boundary; raw Midnight.js types never leak
 * past it (they stay inside this module's REAL branches).
 */
import {
  createUnprovenDeployTx,
  findDeployedContract,
  getPublicStates,
  submitCallTxAsync,
  submitTxAsync,
} from "@midnight-ntwrk/midnight-js-contracts";
import { SucceedEntirely } from "@midnight-ntwrk/midnight-js-types";
import {
  activateAgent,
  emptyLedger,
  flagAgent,
  lockBond,
  processEnforcement,
  reactivateAgent,
  registerAgent,
  releaseBond,
  resolveAgent,
  toPublicContractLedgerView,
  withdrawBond,
} from "@bond/contract";
import type { ContractLedger } from "@bond/contract";
import { CONTRACT_POLICY_VERSION, CONTRACT_VERSION } from "@bond/contract";
import { DomainError, isDomainError } from "@bond/shared-types";
import type {
  BondLockRequest,
  EnforcementRequest,
  RegistrationRequest,
  WithdrawalRequest,
} from "./requests.js";
import { makeBondCompiledContract } from "./compiled.js";
import type { BondCircuitId } from "./compiled.js";
import { BOND_PRIVATE_STATE_ID } from "./witnesses.js";
import type { BondPrivateState } from "./witnesses.js";
import {
  agentStatusFromCode,
  amountToUint64,
  bondStatusFromCode,
  domainIdToBytes32,
  eligibilityNullifierToBytes32,
  enforcementActionToCode,
  nullifierToBytes32,
  policyVersionToBytes32,
} from "./encoding.js";
import type { MidnightConfig } from "./config.js";
import { MidnightError, toMidnightError } from "./errors.js";
import type { BondProviders, WalletAndMidnightProvider } from "./providers.js";
import { buildProviders, buildReadOnlyProviders } from "./providers.js";
import type { PrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";
import { ledger as readLedger } from "../../../contracts/managed/bond/contract/index.js";

export type ChainMode = "SIMULATED" | "REAL";

export interface ChainHandle {
  readonly mode: ChainMode;
  readonly config: MidnightConfig;
  readonly contractAddress: string | null;
  readonly providers: BondProviders | null;
  readonly zkAssetsPath: string;
}

export interface InjectedWallet {
  readonly walletAndMidnightProvider: WalletAndMidnightProvider;
  readonly privateStateProvider: PrivateStateProvider<
    typeof BOND_PRIVATE_STATE_ID,
    BondPrivateState
  >;
}

/**
 * Establishes a chain handle. UNAVAILABLE configs throw; REAL without an
 * injected wallet throws (the adapter never creates keys or wallets).
 * Pure SIMULATED handles need nothing but config.
 */
export function connectMidnight(
  config: MidnightConfig,
  injected?: InjectedWallet,
  zkAssetsPath?: string,
): ChainHandle {
  if (config.mode === "UNAVAILABLE") {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Midnight integration disabled by configuration",
      "UNAVAILABLE",
      {},
    );
  }
  if (config.mode === "SIMULATED") {
    return {
      mode: "SIMULATED",
      config,
      contractAddress: config.contractAddress,
      providers: null,
      zkAssetsPath: zkAssetsPath ?? "",
    };
  }
  if (injected === undefined) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "REAL mode requires an injected operator wallet",
      "REAL",
      {},
    );
  }
  const providers = buildProviders({
    config,
    walletAndMidnightProvider: injected.walletAndMidnightProvider,
    privateStateProvider: injected.privateStateProvider,
    zkAssetsPath: zkAssetsPath ?? "",
  });
  return {
    mode: "REAL",
    config,
    contractAddress: config.contractAddress,
    providers,
    zkAssetsPath: zkAssetsPath ?? "",
  };
}

/**
 * Read-only REAL handle for reconciliation (Phase 12).
 *
 * No wallet, no keys, no submission capability: built on
 * buildReadOnlyProviders, whose wallet provider refuses every signing /
 * submission call. Used by the worker and confirm paths to observe
 * finality — never to create chain activity.
 */
export function connectReadOnly(
  config: MidnightConfig,
  zkAssetsPath?: string,
): ChainHandle {
  if (config.mode === "UNAVAILABLE") {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Midnight integration disabled by configuration",
      "UNAVAILABLE",
      {},
    );
  }
  if (config.mode !== "REAL") {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Read-only observation requires REAL configuration",
      config.mode,
      {},
    );
  }
  const resolvedZkPath = zkAssetsPath ?? "";
  const providers = buildReadOnlyProviders(config, resolvedZkPath);
  return {
    mode: "REAL",
    config,
    contractAddress: config.contractAddress,
    providers,
    zkAssetsPath: resolvedZkPath,
  };
}

export type OperationStatus = "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface OperationResult {
  readonly mode: ChainMode;
  readonly txId: string;
  readonly status: OperationStatus;
  /** SIMULATED post-state (null on REAL — read it back via reads). */
  readonly ledger: ContractLedger | null;
  readonly errorCode: string | null;
}

/** In-memory ledgers backing SIMULATED handles, keyed by handle identity. */
const simulatedLedgers = new WeakMap<object, ContractLedger>();

function simLedgerFor(handle: ChainHandle): ContractLedger {
  const key = handle as object;
  const existing = simulatedLedgers.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const fresh = emptyLedger(CONTRACT_VERSION, CONTRACT_POLICY_VERSION);
  simulatedLedgers.set(key, fresh);
  return fresh;
}

function simId(prefix: string, parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  const input = parts.join("|");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function simSuccess(
  handle: ChainHandle,
  ledger: ContractLedger,
  txParts: readonly string[],
): OperationResult {
  simulatedLedgers.set(handle as object, ledger);
  return {
    mode: "SIMULATED",
    txId: simId("sim", txParts),
    status: "SUBMITTED",
    ledger,
    errorCode: null,
  };
}

function simFailure(
  handle: ChainHandle,
  error: unknown,
  txParts: readonly string[],
): OperationResult {
  void handle;
  const code =
    isDomainError(error) || error instanceof DomainError
      ? (error as DomainError).code
      : "UNKNOWN";
  return {
    mode: "SIMULATED",
    txId: simId("sim-failed", [...txParts, code]),
    status: "FAILED",
    ledger: null,
    errorCode: code,
  };
}

function requireSimulated(handle: ChainHandle): void {
  if (handle.mode !== "SIMULATED") {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "SIMULATED execution requires a SIMULATED handle",
      handle.mode,
      {},
    );
  }
}

function operatorCaller(operatorId: string) {
  return { kind: "operator", operatorId } as const;
}

/** REGISTER AGENT → SIMULATED state transition (SUBMITTED, never CONFIRMED here). */
export function registerAgentOp(
  handle: ChainHandle,
  request: RegistrationRequest,
): OperationResult {
  requireSimulated(handle);
  try {
    const ledger = registerAgent(simLedgerFor(handle), {
      agentId: request.agentId,
      operatorId: request.operatorId,
      caller: operatorCaller(request.operatorId),
    });
    return simSuccess(handle, ledger, ["register", request.agentId]);
  } catch (error) {
    return simFailure(handle, error, ["register", request.agentId]);
  }
}

/** LOCK BOND → SIMULATED state transition. */
export function lockBondOp(
  handle: ChainHandle,
  request: BondLockRequest,
): OperationResult {
  requireSimulated(handle);
  try {
    const ledger = lockBond(simLedgerFor(handle), {
      bondId: request.bondId,
      agentId: request.agentId,
      operatorId: request.operatorId,
      commitmentMinorUnits: request.commitmentMinorUnits,
      caller: operatorCaller(request.operatorId),
    });
    return simSuccess(handle, ledger, ["lock", request.bondId]);
  } catch (error) {
    return simFailure(handle, error, ["lock", request.bondId]);
  }
}

/** Generic SIMULATED lifecycle step (activate/flag/resolve/reactivate). */
export function agentLifecycleOp(
  handle: ChainHandle,
  step: "activate" | "flag" | "resolve" | "reactivate",
  input: { readonly agentId: string; readonly operatorId: string },
): OperationResult {
  requireSimulated(handle);
  try {
    const ledger = simLedgerFor(handle);
    const caller = operatorCaller(input.operatorId);
    const next =
      step === "activate"
        ? activateAgent(ledger, { agentId: input.agentId, caller })
        : step === "flag"
          ? flagAgent(ledger, { agentId: input.agentId, caller })
          : step === "resolve"
            ? resolveAgent(ledger, { agentId: input.agentId, caller })
            : reactivateAgent(ledger, { agentId: input.agentId, caller });
    return simSuccess(handle, next, [step, input.agentId]);
  } catch (error) {
    return simFailure(handle, error, [step, input.agentId]);
  }
}

/** PROCESS ENFORCEMENT → SIMULATED slash (amount from the validated request). */
export function processEnforcementOp(
  handle: ChainHandle,
  request: EnforcementRequest,
  nowIso: string,
): OperationResult {
  requireSimulated(handle);
  try {
    const { ledger } = processEnforcement(simLedgerFor(handle), {
      bondId: request.bondId,
      decision: {
        decisionId: request.decision.decisionId,
        action: request.decision.action,
        nullifier: request.decision.nullifier,
        expiresAt: request.decision.expiresAt,
        agentId: request.decision.agentId,
        riskFlagId: request.decision.riskFlagId,
        policyVersion: request.decision.policyVersion,
        ...(request.decision.amountMinorUnits === undefined
          ? {}
          : { amountMinorUnits: request.decision.amountMinorUnits }),
      },
      caller: {
        kind: "enforcement",
        decisionId: request.decision.decisionId,
      },
      nowIso,
    });
    return simSuccess(handle, ledger, [
      "enforce",
      request.bondId,
      request.decision.nullifier,
    ]);
  } catch (error) {
    return simFailure(handle, error, [
      "enforce",
      request.bondId,
      request.decision.nullifier,
    ]);
  }
}

/** RELEASE + WITHDRAW → SIMULATED transitions. */
export function releaseBondOp(
  handle: ChainHandle,
  input: { readonly bondId: string; readonly operatorId: string },
): OperationResult {
  requireSimulated(handle);
  try {
    const ledger = releaseBond(simLedgerFor(handle), {
      bondId: input.bondId,
      caller: operatorCaller(input.operatorId),
    });
    return simSuccess(handle, ledger, ["release", input.bondId]);
  } catch (error) {
    return simFailure(handle, error, ["release", input.bondId]);
  }
}

export function withdrawBondOp(
  handle: ChainHandle,
  request: WithdrawalRequest,
): OperationResult {
  requireSimulated(handle);
  try {
    const ledger = withdrawBond(simLedgerFor(handle), {
      bondId: request.bondId,
      caller: operatorCaller(request.operatorId),
    });
    return simSuccess(handle, ledger, ["withdraw", request.bondId]);
  } catch (error) {
    return simFailure(handle, error, ["withdraw", request.bondId]);
  }
}

export interface RealCallInput {
  readonly circuitId: BondCircuitId;
  readonly args: readonly (Uint8Array | bigint)[];
  readonly privateState: BondPrivateState;
}

/**
 * Submits one circuit call on REAL providers. Returns SUBMITTED with the
 * chain tx id — CONFIRMED comes only from confirmOperation() after
 * finality. Throws on unavailable handles or submission failure.
 */
export async function submitRealCall(
  handle: ChainHandle,
  input: RealCallInput,
): Promise<OperationResult> {
  if (handle.mode !== "REAL" || handle.providers === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "REAL submission requires a REAL handle with providers",
      handle.mode,
      {},
    );
  }
  const contractAddress = handle.contractAddress;
  if (contractAddress === null) {
    throw new MidnightError(
      "MIDNIGHT_CONFIG_INVALID",
      "REAL calls require a deployed contract address",
      "REAL",
      {},
    );
  }
  try {
    const compiled = makeBondCompiledContract(handle.zkAssetsPath);
    await handle.providers.privateStateProvider.set(
      BOND_PRIVATE_STATE_ID,
      input.privateState,
    );
    // `as never`: Midnight.js call options carry deep generics inferred
    // from the compiled contract type; the verified consumer pattern
    // (midnight-js 4.x DApps) passes them opaquely. All VALUES here are
    // fully typed BOND-side (circuit ids, encoded args, state id).
    const { txId } = await submitCallTxAsync(handle.providers, {
      compiledContract: compiled,
      contractAddress,
      circuitId: input.circuitId,
      args: input.args,
      privateStateId: BOND_PRIVATE_STATE_ID,
    } as never);
    return {
      mode: "REAL",
      txId,
      status: "SUBMITTED",
      ledger: null,
      errorCode: null,
    };
  } catch (error) {
    throw toMidnightError(`call:${input.circuitId}`, "REAL", error);
  }
}

/**
 * Confirms a submitted REAL transaction: watches finality and reports
 * CONFIRMED only on SucceedEntirely, FAILED otherwise. Never infers
 * confirmation from submission.
 */
export async function confirmOperation(
  handle: ChainHandle,
  txId: string,
): Promise<OperationResult> {
  if (handle.mode !== "REAL" || handle.providers === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Confirmation requires a REAL handle with providers",
      handle.mode,
      {},
    );
  }
  try {
    const finalized =
      await handle.providers.publicDataProvider.watchForTxData(txId);
    if (finalized.status === SucceedEntirely) {
      return {
        mode: "REAL",
        txId,
        status: "CONFIRMED",
        ledger: null,
        errorCode: null,
      };
    }
    return {
      mode: "REAL",
      txId,
      status: "FAILED",
      ledger: null,
      errorCode: "MIDNIGHT_CONFIRMATION_FAILED",
    };
  } catch (error) {
    throw toMidnightError("confirm", "REAL", error);
  }
}

/** Deploys the BOND contract on REAL providers (caller supplies wallet + state). */
export async function deployBondContract(
  handle: ChainHandle,
  input: {
    readonly initialPrivateState: BondPrivateState;
    readonly zkAssetsPath?: string;
  },
): Promise<{
  readonly mode: "REAL";
  readonly contractAddress: string;
  readonly txId: string;
}> {
  if (handle.mode !== "REAL" || handle.providers === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Deployment requires a REAL handle with providers",
      handle.mode,
      {},
    );
  }
  try {
    const compiled = makeBondCompiledContract(
      input.zkAssetsPath ?? handle.zkAssetsPath,
    );
    // Low-level deploy (verified consumer pattern): unproven tx first for
    // the contract address, then submit. Returns immediately after submit
    // without waiting for finality.
    const deployTxData = await createUnprovenDeployTx(
      {
        zkConfigProvider: handle.providers.zkConfigProvider,
        walletProvider: handle.providers.walletProvider,
      },
      {
        compiledContract: compiled,
        initialPrivateState: input.initialPrivateState,
      } as never,
    );
    const contractAddress = String(deployTxData.public.contractAddress);
    const txId = await submitTxAsync(handle.providers, {
      unprovenTx: deployTxData.private.unprovenTx,
    });
    await handle.providers.privateStateProvider.setContractAddress(
      contractAddress,
    );
    await handle.providers.privateStateProvider.set(
      BOND_PRIVATE_STATE_ID,
      input.initialPrivateState,
    );
    return { mode: "REAL", contractAddress, txId };
  } catch (error) {
    throw toMidnightError("deploy", "REAL", error);
  }
}

/** Finds an already-deployed BOND contract on REAL providers. */
export async function findBondContract(
  handle: ChainHandle,
  contractAddress: string,
): Promise<{ readonly mode: "REAL"; readonly contractAddress: string }> {
  if (handle.mode !== "REAL" || handle.providers === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Contract lookup requires a REAL handle with providers",
      handle.mode,
      {},
    );
  }
  try {
    const compiled = makeBondCompiledContract(handle.zkAssetsPath);
    // findDeployedContract verifies reachability; the address is the
    // caller's (it was an input), echoed back on success.
    await findDeployedContract(handle.providers, {
      compiledContract: compiled,
      contractAddress,
      privateStateId: BOND_PRIVATE_STATE_ID,
    } as never);
    return { mode: "REAL", contractAddress };
  } catch (error) {
    throw toMidnightError("find", "REAL", error);
  }
}

/**
 * Chain authoritative transaction status for reconciliation.
 *
 * Read-only: queries finality for an already-submitted chain reference.
 * CONFIRMED only on SucceedEntirely; anything else observed is FAILED;
 * unreachable/unknown references throw (caller keeps the row pending —
 * absence of evidence is not evidence of failure).
 *
 * This is the ONLY reconciliation-grade per-tx read: it never submits,
 * never signs, and never invents state.
 */
export async function readTransactionStatus(
  handle: ChainHandle,
  chainTxId: string,
): Promise<"CONFIRMED" | "FAILED"> {
  if (handle.mode !== "REAL" || handle.providers === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Transaction status reads require a REAL handle with providers",
      handle.mode,
      {},
    );
  }
  try {
    const finalized =
      await handle.providers.publicDataProvider.watchForTxData(chainTxId);
    return finalized.status === SucceedEntirely ? "CONFIRMED" : "FAILED";
  } catch (error) {
    throw toMidnightError("read-tx-status", "REAL", error);
  }
}

export interface PublicChainAgentView {
  readonly agentId: string;
  readonly status: string;
  readonly bondStatus: string | null;
  readonly slashCount: number;
}

/**
 * Reads public contract state. REAL: indexer → generated ledger view →
 * mapped bands (no amounts, no operators — the ledger holds none).
 * SIMULATED: projects the in-memory normative ledger through the same
 * band mapping for behavioral parity.
 */
export async function readPublicState(
  handle: ChainHandle,
  input: { readonly agentIds: readonly string[] },
): Promise<readonly PublicChainAgentView[]> {
  if (handle.mode === "SIMULATED") {
    const view = toPublicContractLedgerView(simLedgerFor(handle));
    const wanted = new Set(input.agentIds);
    return view.agents
      .filter((agent) => wanted.has(agent.agentId))
      .map((agent) => ({
        agentId: agent.agentId,
        status: agent.status,
        bondStatus: agent.bondStatus,
        slashCount: agent.slashCount,
      }));
  }
  if (handle.providers === null || handle.contractAddress === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Public reads require a REAL handle with contract address",
      handle.mode,
      {},
    );
  }
  try {
    const { contractState } = await getPublicStates(
      handle.providers.publicDataProvider,
      handle.contractAddress,
    );
    // Generated ledger() reads the state's data field (verified consumer
    // pattern against these exact generated bindings).
    const typed = readLedger(contractState.data);
    const wanted = new Set(
      input.agentIds.map((id) =>
        Buffer.from(domainIdToBytes32(id)).toString("hex"),
      ),
    );
    const views: PublicChainAgentView[] = [];
    for (const [key, agent] of typed.agents) {
      const hex = Buffer.from(key).toString("hex");
      if (!wanted.has(hex)) {
        continue;
      }
      const domainId = input.agentIds.find(
        (id) => Buffer.from(domainIdToBytes32(id)).toString("hex") === hex,
      );
      if (domainId === undefined) {
        continue;
      }
      views.push({
        agentId: domainId,
        status: agentStatusFromCode(agent.status),
        bondStatus: agent.hasBond
          ? bondStatusFromCode(typed.bonds.lookup(agent.bondId).status)
          : null,
        slashCount: Number(agent.slashCount),
      });
    }
    return views;
  } catch (error) {
    throw toMidnightError("read", "REAL", error);
  }
}

/** Builds REAL processEnforcement circuit args from a validated request. */
export function enforcementCircuitArgs(request: {
  readonly agentId: string;
  readonly bondId: string;
  readonly nullifier: string;
  readonly action: "partial-slash" | "full-slash";
  readonly amountMinorUnits: string;
}): readonly (Uint8Array | bigint)[] {
  return [
    domainIdToBytes32(request.agentId),
    domainIdToBytes32(request.bondId),
    nullifierToBytes32(request.nullifier),
    enforcementActionToCode(request.action),
    amountToUint64(request.amountMinorUnits),
  ];
}

/** Builds REAL proveEligibility circuit args from validated inputs. */
export function eligibilityProofCircuitArgs(input: {
  readonly agentId: string;
  readonly policyVersion: string;
  readonly purposeCode: number;
  readonly requiredMinimumMinorUnits: string;
  readonly nullifier: string;
}): readonly (Uint8Array | bigint)[] {
  return [
    domainIdToBytes32(input.agentId),
    policyVersionToBytes32(input.policyVersion),
    BigInt(input.purposeCode),
    amountToUint64(input.requiredMinimumMinorUnits),
    eligibilityNullifierToBytes32(input.nullifier),
  ];
}

export interface EligibilitySubmitInput {
  readonly agentId: string;
  readonly policyVersion: string;
  readonly purposeCode: number;
  readonly requiredMinimumMinorUnits: string;
  readonly nullifier: string;
  readonly privateState: BondPrivateState;
}

/**
 * Submits a REAL proveEligibility call. The private amount/salt stay in
 * the caller's private state; the chain learns only the public statement.
 */
export async function submitEligibilityProof(
  handle: ChainHandle,
  input: EligibilitySubmitInput,
): Promise<OperationResult> {
  return submitRealCall(handle, {
    circuitId: "proveEligibility",
    args: eligibilityProofCircuitArgs(input),
    privateState: input.privateState,
  });
}

/** Submits a REAL revokeEligibility call (operator invalidates a statement). */
export async function submitEligibilityRevocation(
  handle: ChainHandle,
  input: { readonly agentId: string; readonly privateState: BondPrivateState },
): Promise<OperationResult> {
  return submitRealCall(handle, {
    circuitId: "revokeEligibility",
    args: [domainIdToBytes32(input.agentId)],
    privateState: input.privateState,
  });
}

/** Submits a REAL consumeEligibility call (single-use redemption). */
export async function submitEligibilityRedemption(
  handle: ChainHandle,
  input: {
    readonly agentId: string;
    readonly redemptionNullifier: string;
    readonly privateState: BondPrivateState;
  },
): Promise<OperationResult> {
  return submitRealCall(handle, {
    circuitId: "consumeEligibility",
    args: [
      domainIdToBytes32(input.agentId),
      eligibilityNullifierToBytes32(input.redemptionNullifier),
    ],
    privateState: input.privateState,
  });
}

export interface OnChainEligibilityRecord {
  readonly policyHashHex: string;
  readonly purposeCode: number;
  readonly revoked: boolean;
  readonly consumed: boolean;
}

/**
 * Reads one eligibility record from REAL chain state. Returns null when
 * no statement exists (absence ≠ proof — see checkEligibility).
 * Exposes only public ledger fields; the ledger holds no private values.
 */
export async function readEligibilityRecord(
  handle: ChainHandle,
  agentId: string,
): Promise<OnChainEligibilityRecord | null> {
  if (handle.mode !== "REAL" || handle.providers === null) {
    throw new MidnightError(
      "MIDNIGHT_UNAVAILABLE",
      "Eligibility reads require a REAL handle with providers",
      handle.mode,
      {},
    );
  }
  if (handle.contractAddress === null) {
    throw new MidnightError(
      "MIDNIGHT_CONFIG_INVALID",
      "Eligibility reads require a deployed contract address",
      "REAL",
      {},
    );
  }
  try {
    const { contractState } = await getPublicStates(
      handle.providers.publicDataProvider,
      handle.contractAddress,
    );
    const typed = readLedger(contractState.data);
    const key = domainIdToBytes32(agentId);
    if (!typed.eligibility.member(key)) {
      return null;
    }
    const record = typed.eligibility.lookup(key);
    return {
      policyHashHex: Buffer.from(record.policyHash).toString("hex"),
      purposeCode: Number(record.purpose),
      revoked: record.revoked,
      consumed: record.consumed,
    };
  } catch (error) {
    throw toMidnightError("read-eligibility", "REAL", error);
  }
}

export type { BondCircuitId };
