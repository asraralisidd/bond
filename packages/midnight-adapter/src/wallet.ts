/**
 * Wallet identity primitives (Phase 11) — part of the Midnight seam.
 *
 * WHY HERE: the ONLY verified signature-verification primitives in this
 * repository live in the Midnight ledger runtime, which this adapter
 * already wraps. Challenge verification therefore belongs to the sole
 * chain-integration seam, not to route code.
 *
 * Provenance (all inspected in installed packages before use):
 * - `verifySignature(vk, data, signature)` — @midnight-ntwrk/compact-runtime
 *   re-export of ledger-v8 (hex string keys/signatures; Schnorr/BIP340).
 *   Verified locally: valid signature passes, tampered data fails.
 * - `MidnightBech32m.parse` — @midnight-ntwrk/wallet-sdk-address-format@3.1.2
 *   (syntactic bech32m validation with `mn` prefix; no crypto).
 * - `signData`/`signatureVerifyingKey`/`sampleSigningKey` — compact-runtime,
 *   used by tests to produce genuine signatures without any wallet.
 *
 * NOT PROVIDED (no verified primitive exists in this stack):
 * - Proving that a claimed address is controlled by the verifying key.
 *   Address↔key ownership is therefore deferred to wallet approval of a
 *   domain-bound message (see docs/phase-11 — PHASE 12 dependency).
 */
import { verifySignature } from "@midnight-ntwrk/compact-runtime";
import { MidnightBech32m } from "@midnight-ntwrk/wallet-sdk-address-format";

export interface WalletSignature {
  /** Exact message bytes the wallet signed (echoed back by the wallet). */
  readonly data: string;
  /** Hex signature string (ledger Signature type). */
  readonly signature: string;
  /** Hex verifying-key string (ledger SignatureVerifyingKey type). */
  readonly verifyingKey: string;
}

const VK_HEX = /^[0-9a-f]{64}$/i;
const SIG_HEX = /^[0-9a-f]{128}$/i;
const DATA_MAX = 4096;
const SIG_MAX = 512;

/** Domain separator: signatures are BOND-login-only, never cross-service. */
export const WALLET_AUTH_DOMAIN = "BOND wallet authentication v1";

/**
 * Canonical challenge message. Field order and wording are part of the
 * protocol: server recomputes byte-for-byte and rejects any mismatch
 * (wrong domain, wrong nonce, wrong network, tampered fields).
 */
export function buildChallengeMessage(input: {
  readonly nonce: string;
  readonly network: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): string {
  return [
    WALLET_AUTH_DOMAIN,
    `nonce: ${input.nonce}`,
    `network: ${input.network}`,
    `issued: ${input.issuedAt}`,
    `expires: ${input.expiresAt}`,
    "",
  ].join("\n");
}

/** Structural validation before any crypto runs. */
export function parseWalletSignature(raw: unknown): WalletSignature {
  const body = raw as Partial<WalletSignature> | undefined;
  if (
    typeof body?.data !== "string" ||
    typeof body?.signature !== "string" ||
    typeof body?.verifyingKey !== "string"
  ) {
    throw new Error("Malformed wallet signature");
  }
  if (
    body.data.length === 0 ||
    body.data.length > DATA_MAX ||
    body.signature.length === 0 ||
    body.signature.length > SIG_MAX ||
    !SIG_HEX.test(body.signature)
  ) {
    throw new Error("Malformed wallet signature");
  }
  if (!VK_HEX.test(body.verifyingKey)) {
    throw new Error("Malformed wallet verifying key");
  }
  return {
    data: body.data,
    signature: body.signature.toLowerCase(),
    verifyingKey: body.verifyingKey.toLowerCase(),
  };
}

/**
 * Verifies a wallet signature over `expectedMessage`.
 *
 * Fail-closed: any structural, encoding, or verification failure returns
 * false. Never throws on adversarial input.
 */
export function verifyWalletSignature(
  signature: WalletSignature,
  expectedMessage: string,
): boolean {
  try {
    if (signature.data !== expectedMessage) {
      return false;
    }
    const dataBytes = new TextEncoder().encode(signature.data);
    return verifySignature(
      signature.verifyingKey,
      dataBytes,
      signature.signature,
    );
  } catch {
    return false;
  }
}

/**
 * Syntactic validation of a Midnight address string (`mn_` bech32m).
 * Shape only — explicitly NOT proof of ownership (see module header).
 */
export function isValidMidnightAddress(address: string): boolean {
  try {
    MidnightBech32m.parse(address);
    return true;
  } catch {
    return false;
  }
}
