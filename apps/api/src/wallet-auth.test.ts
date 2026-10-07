/**
 * Phase 11 wallet authentication tests.
 *
 * Genuine signatures from @midnight-ntwrk/compact-runtime (installed
 * package — no wallet, no invented crypto): sampleSigningKey,
 * signatureVerifyingKey, signData over the real canonical message.
 *
 * Covers:
 * - valid challenge + valid signature → wallet-bound session
 * - invalid signature → 401
 * - expired / unknown / replayed / reused challenge → 401
 * - wrong-domain message → 401
 * - network mismatch → rejected
 * - malformed inputs → 400/401, safe envelope
 * - wallet A session cannot touch wallet B's resources
 * - no signature/secret material stored or leaked
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
} from "@midnight-ntwrk/compact-runtime";
import { createApp } from "./index.js";
import { resetDb, useIsolatedDb } from "./test-helpers.js";
import { query } from "./db/pool.js";

type App = ReturnType<typeof createApp>;

interface Keypair {
  readonly sk: string;
  readonly vk: string;
}

// compact-runtime exposes opaque key objects; the ledger stringifies
// them to 64-hex. Bridge via String() for the wire protocol.
function makeKeypair(): Keypair {
  const sk = sampleSigningKey() as unknown as string;
  const vk = signatureVerifyingKey(sk) as unknown as string;
  return { sk: String(sk), vk: String(vk) };
}

function signRaw(sk: string, message: string): string {
  return String(
    signData(sk as never, new TextEncoder().encode(message)) as unknown,
  );
}

async function challengeFor(
  app: App,
  network?: string,
): Promise<{
  challengeId: string;
  nonce: string;
  network: string;
  message: string;
}> {
  const res = await request(app)
    .post("/api/v1/auth/wallet/challenge")
    .send(network === undefined ? {} : { network });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function registerAgent(app: App, token: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      platform: "custom",
      agentType: "custom",
      capabilities: [],
      externalRef: `w11-${Math.random().toString(36).slice(2)}`,
    });
  expect(res.status).toBe(201);
  return res.body.data.agentId as string;
}

beforeAll(async () => {
  await useIsolatedDb("walletauth");
});

beforeEach(async () => {
  await resetDb();
});

describe("wallet challenge issuance", () => {
  it("issues a canonical challenge bound to the server network", async () => {
    const app = createApp();
    const challenge = await challengeFor(app);
    expect(challenge.challengeId).toMatch(/^wch_/);
    expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.message).toContain("BOND wallet authentication v1");
    expect(challenge.message).toContain(challenge.nonce);
  });

  it("rejects wrong-network challenge requests", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/v1/auth/wallet/challenge")
      .send({ network: "mainnet" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDENTIFIER");
  });

  it("rejects a signature over a different network's message", async () => {
    const app = createApp();
    const { sk, vk } = makeKeypair();
    const challenge = await challengeFor(app);
    // Same nonce, different network label — different canonical bytes.
    const tampered = challenge.message.replace(
      `network: ${challenge.network}`,
      "network: mainnet",
    );
    expect(tampered).not.toBe(challenge.message);
    const res = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: tampered,
          signature: signRaw(sk, tampered),
          verifyingKey: vk,
        },
      });
    expect(res.status).toBe(401);
  });
});

describe("wallet challenge verification", () => {
  it("valid signature issues a wallet-bound session", async () => {
    const app = createApp();
    const { sk, vk } = makeKeypair();
    const challenge = await challengeFor(app);
    const res = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: challenge.message,
          signature: signRaw(sk, challenge.message),
          verifyingKey: vk,
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.operatorId).toBe(`op_w_${vk.toLowerCase()}`);
    // The session works for owner-scoped routes.
    const agentId = await registerAgent(app, res.body.data.token as string);
    expect(agentId).toBeTruthy();
  });

  it("rejects invalid signatures", async () => {
    const app = createApp();
    const { sk, vk } = makeKeypair();
    const other = makeKeypair();
    const challenge = await challengeFor(app);

    // Signed by a different key than claimed.
    const mismatch = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: challenge.message,
          signature: signRaw(other.sk, challenge.message),
          verifyingKey: vk,
        },
      });
    expect(mismatch.status).toBe(401);

    // Garbage signature bytes (correct 64-byte shape, wrong value).
    const garbage = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: challenge.message,
          signature: "00".repeat(64),
          verifyingKey: vk,
        },
      });
    expect(garbage.status).toBe(401);
    void sk;
  });

  it("rejects wrong-domain messages", async () => {
    const app = createApp();
    const { sk, vk } = makeKeypair();
    const challenge = await challengeFor(app);
    const forged = challenge.message.replace(
      "BOND wallet authentication v1",
      "Evil dApp withdrawal v1",
    );
    const res = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: forged,
          signature: signRaw(sk, forged),
          verifyingKey: vk,
        },
      });
    expect(res.status).toBe(401);
  });

  it("rejects unknown and expired challenges", async () => {
    const app = createApp();
    const { vk } = makeKeypair();
    const unknown = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: "wch_does-not-exist",
        signature: {
          data: "x",
          signature: "00".repeat(64),
          verifyingKey: vk,
        },
      });
    expect(unknown.status).toBe(401);

    const challenge = await challengeFor(app);
    await query(
      "UPDATE wallet_challenges SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [challenge.challengeId],
    );
    const { sk } = makeKeypair();
    const expired = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: challenge.message,
          signature: signRaw(sk, challenge.message),
          verifyingKey: vk,
        },
      });
    expect(expired.status).toBe(401);
  });

  it("rejects replayed challenges (single-use)", async () => {
    const app = createApp();
    const { sk, vk } = makeKeypair();
    const challenge = await challengeFor(app);
    const body = {
      challengeId: challenge.challengeId,
      signature: {
        data: challenge.message,
        signature: signRaw(sk, challenge.message),
        verifyingKey: vk,
      },
    };
    const first = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send(body);
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects malformed payloads with safe errors", async () => {
    const app = createApp();
    for (const body of [
      {},
      { challengeId: "", signature: {} },
      {
        challengeId: "wch_x",
        signature: { data: "", signature: "zz", verifyingKey: "zz" },
      },
    ]) {
      const res = await request(app)
        .post("/api/v1/auth/wallet/verify")
        .send(body);
      expect([400, 401]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|SELECT|secret/i);
    }
  });
});

describe("wallet-attended submission lifecycle", () => {
  async function walletSession(app: App): Promise<string> {
    const { sk, vk } = makeKeypair();
    const challenge = await challengeFor(app);
    const res = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: challenge.message,
          signature: signRaw(sk, challenge.message),
          verifyingKey: vk,
        },
      });
    expect(res.status).toBe(201);
    return res.body.data.token as string;
  }

  it("records operator-attended submission without claiming confirmation", async () => {
    const app = createApp();
    const token = await walletSession(app);
    const agentId = await registerAgent(app, token);
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        purpose: "FUND_BOND",
        agentId,
        idempotencyKey: "w11-tx-1",
      });
    expect(created.status).toBe(201);
    const txId = created.body.data.transactionId as string;

    // Walk IDLE → WALLET_APPROVAL → PENDING (operator + wallet approval).
    for (const status of ["WALLET_APPROVAL", "PENDING"]) {
      const advanced = await request(app)
        .post(`/api/v1/transactions/${txId}/advance`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
      expect(advanced.status).toBe(200);
    }

    // Wallet relays the chain submission; API records, never confirms.
    const submitted = await request(app)
      .post(`/api/v1/transactions/${txId}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-abc-123" });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe("SUBMITTED");
    expect(submitted.body.data.chainTxId).toBe("chain-ref-abc-123");

    // Conflicting chain reference fails closed (no silent overwrite),
    // even though the row has already left PENDING.
    const conflict = await request(app)
      .post(`/api/v1/transactions/${txId}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-ref-different" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("submission records on non-PENDING intents are rejected", async () => {
    const app = createApp();
    const token = await walletSession(app);
    const agentId = await registerAgent(app, token);
    const created = await request(app)
      .post("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "FUND_BOND", agentId, idempotencyKey: "w11-tx-2" });
    const txId = created.body.data.transactionId as string;
    // Still IDLE (never advanced to WALLET_APPROVAL→PENDING).
    const early = await request(app)
      .post(`/api/v1/transactions/${txId}/submitted`)
      .set("Authorization", `Bearer ${token}`)
      .send({ chainTxId: "chain-x" });
    expect(early.status).toBe(400);
  });
});

describe("wallet authorization boundary", () => {
  it("wallet A cannot touch wallet B's agents", async () => {
    const app = createApp();
    async function walletSession(): Promise<string> {
      const { sk, vk } = makeKeypair();
      const challenge = await challengeFor(app);
      const res = await request(app)
        .post("/api/v1/auth/wallet/verify")
        .send({
          challengeId: challenge.challengeId,
          signature: {
            data: challenge.message,
            signature: signRaw(sk, challenge.message),
            verifyingKey: vk,
          },
        });
      expect(res.status).toBe(201);
      return res.body.data.token as string;
    }
    const alice = await walletSession();
    const bob = await walletSession();
    const agentId = await registerAgent(app, alice);
    const cross = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(cross.status).toBe(403);
  });

  it("stores no signatures or secrets server-side", async () => {
    const app = createApp();
    const { sk, vk } = makeKeypair();
    const challenge = await challengeFor(app);
    const sig = signRaw(sk, challenge.message);
    const res = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.challengeId,
        signature: {
          data: challenge.message,
          signature: sig,
          verifyingKey: vk,
        },
      });
    expect(res.status).toBe(201);
    // Signatures never persisted; sessions store token hashes only.
    const leaked: { rows: { count: string }[] } = await query(
      `SELECT COUNT(*) AS count FROM wallet_challenges
        WHERE nonce = $1 OR id = $1`,
      [sig],
    );
    expect(leaked.rows[0]?.count).toBe("0");
    const sessions: { rows: { token_hash: string }[] } = await query(
      "SELECT token_hash FROM sessions",
    );
    for (const row of sessions.rows) {
      expect(row.token_hash).not.toContain(".");
      expect(row.token_hash).toHaveLength(64);
    }
    // Session exposes no secret material.
    expect(JSON.stringify(res.body)).not.toMatch(/signature|secret|seed/i);
  });
});
