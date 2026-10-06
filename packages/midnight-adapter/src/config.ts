/**
 * Network configuration: presets + environment, no secrets, no keys.
 *
 * Modes:
 * - SIMULATED: in-memory normative rules (@bond/contract), explicitly
 *   labeled receipts. Default when no network is configured. NEVER
 *   presented as chain activity.
 * - REAL: live Midnight.js submission paths. Requires injected wallet +
 *   reachable endpoints. Anything missing → UNAVAILABLE error, never a
 *   fake success.
 * - UNAVAILABLE: operations refuse with a structured error.
 *
 * Secrets (wallet keys, signing keys, private state) NEVER come from env
 * here — they arrive via injected providers/session objects only.
 */
import { DomainError } from "@bond/shared-types";

export type MidnightMode = "SIMULATED" | "REAL" | "UNAVAILABLE";

export type MidnightNetworkId =
  "undeployed" | "preprod" | "preview" | "mainnet";

export interface MidnightEndpoints {
  readonly networkId: MidnightNetworkId;
  readonly indexerHttp: string;
  readonly indexerWs: string;
  readonly nodeUrl: string;
  readonly proofServerUrl: string;
}

export interface MidnightConfig {
  readonly mode: MidnightMode;
  readonly endpoints: MidnightEndpoints | null;
  readonly contractAddress: string | null;
  readonly zkAssetsPath: string | null;
}

const UNDEPLOYED_DEFAULTS: MidnightEndpoints = {
  networkId: "undeployed",
  indexerHttp: "http://127.0.0.1:8088/api/v4/graphql",
  indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  nodeUrl: "http://127.0.0.1:9944",
  proofServerUrl: "http://127.0.0.1:6300",
};

const PREPROD_DEFAULTS: MidnightEndpoints = {
  networkId: "preprod",
  indexerHttp: "https://indexer.preprod.midnight.network/api/v4/graphql",
  indexerWs: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
  nodeUrl: "https://rpc.preprod.midnight.network",
  proofServerUrl: "http://127.0.0.1:6300",
};

function isNetworkId(value: string): value is MidnightNetworkId {
  return (
    value === "undeployed" ||
    value === "preprod" ||
    value === "preview" ||
    value === "mainnet"
  );
}

/**
 * Resolves adapter configuration from the environment. Pure function of
 * the provided env mapping (defaults to process.env) — deterministic and
 * fully testable. Never reads secrets.
 */
export function resolveMidnightConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MidnightConfig {
  const rawNetwork = (env.MIDNIGHT_NETWORK ?? "").trim().toLowerCase();
  const contractAddress = env.BOND_CONTRACT_ADDRESS?.trim() || null;
  const zkAssetsPath = env.BOND_ZK_ASSETS_PATH?.trim() || null;
  if (rawNetwork === "" || rawNetwork === "simulated") {
    return {
      mode: "SIMULATED",
      endpoints: null,
      contractAddress,
      zkAssetsPath,
    };
  }
  if (rawNetwork === "off" || rawNetwork === "unavailable") {
    return {
      mode: "UNAVAILABLE",
      endpoints: null,
      contractAddress,
      zkAssetsPath,
    };
  }
  if (!isNetworkId(rawNetwork)) {
    throw new DomainError(
      "INVALID_IDENTIFIER",
      `Unknown MIDNIGHT_NETWORK: ${rawNetwork}`,
      {
        value: rawNetwork,
      },
    );
  }
  const defaults =
    rawNetwork === "undeployed" ? UNDEPLOYED_DEFAULTS : PREPROD_DEFAULTS;
  const endpoints: MidnightEndpoints = {
    networkId: rawNetwork,
    indexerHttp: env.MIDNIGHT_INDEXER_HTTP?.trim() || defaults.indexerHttp,
    indexerWs: env.MIDNIGHT_INDEXER_WS?.trim() || defaults.indexerWs,
    nodeUrl: env.MIDNIGHT_NODE_URL?.trim() || defaults.nodeUrl,
    proofServerUrl: env.PROOF_SERVER_URL?.trim() || defaults.proofServerUrl,
  };
  return { mode: "REAL", endpoints, contractAddress, zkAssetsPath };
}

/** `.env.example` documentation contract: every key resolveMidnightConfig reads. */
export const MIDNIGHT_ENV_KEYS = [
  "MIDNIGHT_NETWORK",
  "MIDNIGHT_INDEXER_HTTP",
  "MIDNIGHT_INDEXER_WS",
  "MIDNIGHT_NODE_URL",
  "PROOF_SERVER_URL",
  "BOND_CONTRACT_ADDRESS",
  "BOND_ZK_ASSETS_PATH",
] as const;
