/**
 * Midnight DApp Connector surface (Phase 11).
 *
 * This module types the VERIFIED wallet API (dapp-connector-api 4.0.1,
 * inspected from the published package — NOT bundled; the wallet
 * injects it at `window.midnight`). Only the subset BOND needs:
 * connect → shielded/unshielded addresses → signData (unshielded key)
 * → submitTransaction (wallet as relayer) → getConfiguration.
 *
 * Verified facts:
 * - Initial API lives under `window.midnight[rdns]` with `connect(networkId)`.
 * - `signData(data, { encoding, keyType: 'unshielded' })` returns
 *   `{ data, signature, verifyingKey }` (hex strings).
 * - `getConfiguration()` returns `{ networkId, ... }` for mismatch checks.
 *
 * No private keys or secrets ever pass through this module — the wallet
 * signs internally and returns only public signature material.
 */

export type WalletRdns = string;

export interface WalletSignaturePayload {
  data: string;
  signature: string;
  verifyingKey: string;
}

export interface WalletAddresses {
  unshieldedAddress: string;
  shieldedAddress: string;
}

export interface ConnectedWallet {
  readonly rdns: WalletRdns;
  readonly name: string;
  getAddresses: () => Promise<WalletAddresses>;
  /** Sign the exact canonical message (user-approved in the wallet). */
  signMessage: (message: string) => Promise<WalletSignaturePayload>;
  /** Network the wallet is connected to (validated against the server). */
  getNetworkId: () => Promise<string>;
  /** Wallet as relayer for an already-balanced sealed transaction. */
  submitTransaction: (sealedTx: string) => Promise<void>;
}

interface InjectedInitialApi {
  readonly rdns: string;
  readonly name: string;
  readonly apiVersion: string;
  connect: (networkId: string) => Promise<InjectedConnectedApi>;
}

interface InjectedConnectedApi {
  getUnshieldedAddress: () => Promise<{ unshieldedAddress: string }>;
  getShieldedAddresses: () => Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  signData: (
    data: string,
    options: { encoding: "text"; keyType: "unshielded" },
  ) => Promise<WalletSignaturePayload>;
  submitTransaction: (tx: string) => Promise<void>;
  getConfiguration: () => Promise<{ networkId: string }>;
}

function injected(): Record<string, InjectedInitialApi> {
  const scope = (window as unknown as { midnight?: unknown }).midnight;
  if (scope === null || typeof scope !== "object") {
    return {};
  }
  return scope as Record<string, InjectedInitialApi>;
}

/** Wallets currently injected (Lace or compatible). Empty = unavailable. */
export function availableWallets(): { rdns: WalletRdns; name: string }[] {
  return Object.values(injected()).map((w) => ({
    rdns: w.rdns,
    name: w.name,
  }));
}

export async function connectWallet(
  rdns: WalletRdns,
  networkId: string,
): Promise<ConnectedWallet> {
  const initial = injected()[rdns];
  if (!initial) {
    throw new Error("Wallet not available");
  }
  const api = await initial.connect(networkId);
  return {
    rdns,
    name: initial.name,
    getAddresses: async () => {
      const [unshielded, shielded] = await Promise.all([
        api.getUnshieldedAddress(),
        api.getShieldedAddresses(),
      ]);
      return {
        unshieldedAddress: unshielded.unshieldedAddress,
        shieldedAddress: shielded.shieldedAddress,
      };
    },
    signMessage: (message: string) =>
      api.signData(message, { encoding: "text", keyType: "unshielded" }),
    getNetworkId: async () => (await api.getConfiguration()).networkId,
    submitTransaction: (tx: string) => api.submitTransaction(tx),
  };
}
