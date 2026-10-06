/**
 * Idempotency: same key + same fingerprint replays the stored result;
 * same key + different fingerprint fails closed (409). Keys expire
 * (default 24h). Failures mark the key failed so clients can retry
 * with a new key.
 */
import { createHash } from "node:crypto";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from "../db/stores/chain.js";
import { ApiError } from "../http/errors.js";

export function fingerprintRequest(route: string, body: unknown): string {
  return createHash("sha256")
    .update(`${route}:${stableStringify(body)}`, "utf8")
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`;
}

export interface IdempotentOutcome<T> {
  readonly replayed: boolean;
  readonly body: T;
}

export async function runIdempotent<T>(input: {
  readonly key: string | undefined;
  readonly operatorId: string;
  readonly route: string;
  readonly fingerprint: string;
  readonly execute: () => Promise<T>;
}): Promise<IdempotentOutcome<T>> {
  if (!input.key) {
    return { replayed: false, body: await input.execute() };
  }
  const claim = await claimIdempotencyKey({
    key: input.key,
    operatorId: input.operatorId,
    route: input.route,
    fingerprint: input.fingerprint,
  });
  if (!claim.inserted) {
    const existing = claim.row;
    if (!existing) {
      throw new ApiError("INTERNAL_ERROR", "Idempotency state missing");
    }
    if (existing.request_fingerprint !== input.fingerprint) {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key already used for a different request",
      );
    }
    if (existing.status === "completed") {
      return { replayed: true, body: existing.response_snapshot as T };
    }
    throw new ApiError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key already in progress",
    );
  }
  try {
    const body = await input.execute();
    await completeIdempotencyKey(input.key, body);
    return { replayed: false, body };
  } catch (error) {
    await failIdempotencyKey(input.key);
    throw error;
  }
}
