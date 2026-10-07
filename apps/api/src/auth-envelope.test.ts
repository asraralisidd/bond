/**
 * Auth response-envelope tests: both session-issuing endpoints must
 * return the standard { data: { token, operatorId, sessionId } }
 * envelope at HTTP 201, matching what the web client unwraps.
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

const DEV_KEY = "test-dev-key";

beforeAll(async () => {
  await useIsolatedDb("authenvelope");
});

beforeEach(async () => {
  await resetDb();
});

describe("POST /session envelope", () => {
  it("returns 201 with enveloped token, operatorId, and sessionId", async () => {
    const app = createApp();
    process.env.DEV_AUTH_TOKEN = DEV_KEY;
    const res = await request(app)
      .post("/api/v1/auth/session")
      .send({ devKey: DEV_KEY, externalKey: "envelope-alice" });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.operatorId).toBe("op_envelope-alice");
    expect(res.body.data.sessionId).toBeTruthy();
    expect(res.body.token).toBeUndefined();
  });
});

describe("POST /wallet/verify envelope", () => {
  it("returns 201 with enveloped token, operatorId, and sessionId", async () => {
    const app = createApp();
    const challenge = await request(app)
      .post("/api/v1/auth/wallet/challenge")
      .send({});
    expect(challenge.status).toBe(201);
    const sk = String(sampleSigningKey());
    const vk = String(signatureVerifyingKey(sk));
    const message = challenge.body.data.message as string;
    const res = await request(app)
      .post("/api/v1/auth/wallet/verify")
      .send({
        challengeId: challenge.body.data.challengeId,
        signature: {
          data: message,
          signature: String(
            signData(sk as never, new TextEncoder().encode(message)),
          ),
          verifyingKey: vk,
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.operatorId).toBe(`op_w_${vk.toLowerCase()}`);
    expect(res.body.data.sessionId).toBeTruthy();
    expect(res.body.token).toBeUndefined();
  });
});
