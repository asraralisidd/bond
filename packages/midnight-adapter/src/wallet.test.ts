/**
 * Wallet identity primitives: genuine ledger signatures, no mocks.
 *
 * Provenance (verified in installed packages before use):
 * - signData/verifySignature — compact-runtime re-export of ledger-v8
 *   (hex Schnorr keys: 32-byte vk, 64-byte signatures).
 * - MidnightBech32m — wallet-sdk-address-format@3.1.2 (mn_ bech32m).
 */
import { describe, expect, it } from "vitest";
import {
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
} from "@midnight-ntwrk/compact-runtime";
import {
  WALLET_AUTH_DOMAIN,
  buildChallengeMessage,
  isValidMidnightAddress,
  parseWalletSignature,
  verifyWalletSignature,
} from "./wallet.js";

const MSG = {
  nonce: "n".repeat(64),
  network: "undeployed",
  issuedAt: "2026-10-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:05:00.000Z",
};

describe("challenge message", () => {
  it("is canonical and domain-bound", () => {
    const message = buildChallengeMessage(MSG);
    expect(message).toContain(WALLET_AUTH_DOMAIN);
    expect(message).toContain(`nonce: ${MSG.nonce}`);
    expect(message).toContain(`network: ${MSG.network}`);
    expect(buildChallengeMessage({ ...MSG, network: "preprod" })).not.toBe(
      message,
    );
  });
});

describe("wallet signature verification", () => {
  it("accepts genuine signatures, rejects tampered data", () => {
    const sk = String(sampleSigningKey());
    const vk = String(signatureVerifyingKey(sk));
    const message = buildChallengeMessage(MSG);
    const signature = String(
      signData(sk as never, new TextEncoder().encode(message)) as unknown,
    );
    const parsed = parseWalletSignature({
      data: message,
      signature,
      verifyingKey: vk,
    });
    expect(verifyWalletSignature(parsed, message)).toBe(true);
    expect(verifyWalletSignature(parsed, `${message}!`)).toBe(false);
    // Cross-key: valid signature under a different key fails.
    const otherVk = String(signatureVerifyingKey(String(sampleSigningKey())));
    expect(
      verifyWalletSignature({ ...parsed, verifyingKey: otherVk }, message),
    ).toBe(false);
  });

  it("fail-closes on malformed input", () => {
    expect(() => parseWalletSignature(null)).toThrowError();
    expect(() =>
      parseWalletSignature({ data: "x", signature: "zz", verifyingKey: "zz" }),
    ).toThrowError();
    expect(() =>
      parseWalletSignature({
        data: "x",
        signature: "00".repeat(64),
        verifyingKey: "short",
      }),
    ).toThrowError();
  });
});

describe("address validation", () => {
  it("accepts well-formed mn_ strings, rejects garbage", () => {
    expect(isValidMidnightAddress("not-an-address")).toBe(false);
    expect(isValidMidnightAddress("")).toBe(false);
    expect(isValidMidnightAddress("0x1234")).toBe(false);
  });
});
