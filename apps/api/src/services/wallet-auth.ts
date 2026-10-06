/**
 * Wallet challenge-response authentication (Phase 11).
 *
 * Protocol (nonce pattern; no invented cryptography):
 *  1. Client requests a challenge for the network it is on.
 *  2. Server stores a single-use, short-lived challenge (nonce +
 *     domain + network, canonical message) and returns it.
 *  3. The wallet signs the canonical message (connector signData,
 *     user-approved) — the response carries the verifying key.
 *  4. Server verifies the signature over the exact expected message
 *     under the key the wallet signed WITH, consumes the challenge,
 *     and issues a session bound to that key.
 *
 * Identity: the verifying key that produced a valid signature IS the
 * identity (self-certifying). No address/key linkage claim is made or
 * trusted here — the signature proves control of the key; the session
 * is bound to it.
 *
 * Cryptography lives in @bond/midnight-adapter (the sole seam):
 * buildChallengeMessage / parseWalletSignature / verifyWalletSignature.
 * This service adds issuance, expiry, single-use, and binding.
 *
 * Security properties:
 * - Challenges expire (default 5 min, bounded env override).
 * - Challenges are single-use (consumed atomically with session issue;
 *   concurrent replays lose the atomic UPDATE).
 * - Signatures bind the BOND domain + network + nonce (message is
 *   recomputed server-side from stored fields; client echoes untrusted).
 * - No session is created for an arbitrary claimed wallet: the session
 *   is bound to the verifying key that actually signed.
 * - No private keys, seeds, or signatures are stored.
 */
import { randomBytes } from "node:crypto";
import {
  buildChallengeMessage,
  parseWalletSignature,
  verifyWalletSignature,
} from "@bond/midnight-adapter";
import { ApiError } from "../http/errors.js";
import { query, withTransaction } from "../db/pool.js";
import { createOperator, hashToken, newToken } from "../db/stores/operators.js";

const NETWORK_MAX = 64;

function challengeTtlMs(): number {
  const raw = process.env.WALLET_CHALLENGE_TTL_MS;
  if (raw === undefined || raw === "") {
    return 5 * 60 * 1000;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60_000 || value > 30 * 60 * 1000) {
    throw new ApiError("INTERNAL_ERROR", "Invalid WALLET_CHALLENGE_TTL_MS");
  }
  return value;
}

/** Server's configured network. Never derived from client claims. */
export function serverWalletNetwork(): string {
  const raw = (process.env.MIDNIGHT_NETWORK ?? "").trim().toLowerCase();
  return raw === "" || raw === "simulated" ? "simulated" : raw;
}

export function parseNetwork(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > NETWORK_MAX ||
    !/^[a-z0-9-]+$/i.test(value)
  ) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid network");
  }
  return value.toLowerCase();
}

export interface WalletChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly network: string;
  readonly message: string;
  readonly expiresAt: string;
}

export async function requestWalletChallenge(input: {
  readonly network?: unknown;
}): Promise<WalletChallenge> {
  const network =
    input.network === undefined
      ? serverWalletNetwork()
      : parseNetwork(input.network);
  // Wrong-network clients are rejected before any challenge exists:
  // signing a challenge for a different deployment must never succeed.
  if (network !== serverWalletNetwork()) {
    throw new ApiError("INVALID_IDENTIFIER", "Network mismatch");
  }
  const nonce = randomBytes(32).toString("hex");
  const id = `wch_${randomBytes(12).toString("hex")}`;
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + challengeTtlMs()).toISOString();
  const message = buildChallengeMessage({
    nonce,
    network,
    issuedAt,
    expiresAt,
  });
  await query(
    `INSERT INTO wallet_challenges (id, nonce, network, message, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, nonce, network, message, expiresAt],
  );
  return {
    challengeId: id,
    nonce,
    network,
    message,
    expiresAt,
  };
}

export async function verifyWalletChallenge(input: {
  readonly challengeId: unknown;
  readonly signature: unknown;
}): Promise<{ token: string; operatorId: string; sessionId: string }> {
  if (typeof input.challengeId !== "string" || input.challengeId.length === 0) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid challenge");
  }
  let signature;
  try {
    signature = parseWalletSignature(input.signature);
  } catch {
    throw new ApiError("UNAUTHORIZED", "Invalid wallet signature");
  }
  return withTransaction(async (client) => {
    const found: {
      rows: {
        id: string;
        message: string;
        expires_at: string;
        consumed_at: string | null;
      }[];
    } = await query(
      `SELECT id, message,
          to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          consumed_at
       FROM wallet_challenges WHERE id = $1`,
      [input.challengeId],
      client,
    );
    const challenge = found.rows[0];
    if (!challenge) {
      throw new ApiError("UNAUTHORIZED", "Unknown or expired challenge");
    }
    if (challenge.consumed_at !== null) {
      throw new ApiError("UNAUTHORIZED", "Challenge already used");
    }
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      throw new ApiError("UNAUTHORIZED", "Challenge expired");
    }
    // verifyWalletSignature fail-closes on any mismatch — including a
    // wrong-domain message echoed back by the wallet.
    if (!verifyWalletSignature(signature, challenge.message)) {
      throw new ApiError("UNAUTHORIZED", "Invalid wallet signature");
    }
    // Identity: the key that signed. Session binds it; operator id is
    // derived from it (collision-free across wallets and dev ids).
    const verifyingKey = signature.verifyingKey;
    const operatorId = `op_w_${verifyingKey}`;
    await createOperator(operatorId, `wallet:${verifyingKey}`);
    const { id: sessionId, token } = newToken("sess");
    const sessionExpires = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();
    // Atomic single-use: only the first transaction to mark the
    // challenge consumed issues a session.
    const consumed = await query(
      `UPDATE wallet_challenges
         SET consumed_at = now(), consumed_by_session = $2,
             verified_verifying_key = $3
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id`,
      [challenge.id, sessionId, verifyingKey],
      client,
    );
    if (consumed.rows.length === 0) {
      throw new ApiError("UNAUTHORIZED", "Challenge already used");
    }
    await query(
      `INSERT INTO sessions (id, operator_id, token_hash, expires_at, auth_method, wallet_verifying_key, challenge_id)
       VALUES ($1, $2, $3, $4, 'wallet', $5, $6)`,
      [
        sessionId,
        operatorId,
        hashToken(token),
        sessionExpires,
        verifyingKey,
        challenge.id,
      ],
      client,
    );
    return { token, operatorId, sessionId };
  });
}
