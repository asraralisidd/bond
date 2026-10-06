/**
 * Provider assembly: verified Midnight.js 4.1.1 wiring, no invented APIs.
 *
 * - Reads: indexer public-data provider + node ZK-config provider + HTTP
 *   proof provider (all constructed from config URLs — verified exports).
 * - Writes: wallet + midnight providers are INJECTED (operator wallet,
 *   e.g. Lace session). The adapter never creates keys or wallets.
 * - Private-state provider is INJECTED (owned by the wallet layer).
 * - Network id is set globally via setNetworkId (verified export).
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type {
  MidnightProvider,
  MidnightProviders,
  PrivateStateProvider,
  WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import type { MidnightConfig } from "./config.js";
import { MidnightError } from "./errors.js";
import type { BondCircuitId } from "./compiled.js";
import type { BondPrivateState, BondPrivateStateId } from "./witnesses.js";

export type WalletAndMidnightProvider = WalletProvider & MidnightProvider;

export type BondProviders = MidnightProviders<
  BondCircuitId,
  BondPrivateStateId,
  BondPrivateState
>;

export interface ProviderBundleInput {
  readonly config: MidnightConfig;
  readonly walletAndMidnightProvider: WalletAndMidnightProvider;
  readonly privateStateProvider: PrivateStateProvider<
    BondPrivateStateId,
    BondPrivateState
  >;
  readonly zkAssetsPath: string;
}

/**
 * Assembles the full provider bundle for REAL submission paths.
 * Throws MIDNIGHT_CONFIG_INVALID when endpoints are absent (SIMULATED
 * configs cannot build network providers — callers must branch on mode).
 */
export function buildProviders(input: ProviderBundleInput): BondProviders {
  const { endpoints } = input.config;
  if (endpoints === null) {
    throw new MidnightError(
      "MIDNIGHT_CONFIG_INVALID",
      "Network endpoints required for provider assembly",
      input.config.mode,
      {},
    );
  }
  setNetworkId(endpoints.networkId);
  const zkConfigProvider = new NodeZkConfigProvider<BondCircuitId>(
    input.zkAssetsPath,
  );
  return {
    privateStateProvider: input.privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(
      endpoints.indexerHttp,
      endpoints.indexerWs,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(
      endpoints.proofServerUrl,
      zkConfigProvider,
    ),
    walletProvider: input.walletAndMidnightProvider,
    midnightProvider: input.walletAndMidnightProvider,
  };
}
