/**
 * Development-only brute-force guard for POST /auth/session.
 *
 * Explicitly DEVELOPMENT-ONLY: production forbids DEV_AUTH_TOKEN
 * entirely (config fail-closed), so this code path is unreachable in
 * production. It exists to slow credential guessing against the shared
 * dev key on shared dev machines — not as a production control. No
 * external store (no Redis by architectural constraint); per-process
 * memory with automatic expiry. Real rate limiting is Phase 9.5.
 */
import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors.js";

interface AttemptBucket {
  failures: number;
  resetAt: number;
}

const buckets = new Map<string, AttemptBucket>();

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;

export function devBruteForceGuard(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const key = `${req.ip ?? "unknown"}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt <= now) {
    buckets.delete(key);
  }
  const current = buckets.get(key);
  if (current && current.failures >= MAX_FAILURES) {
    next(
      new ApiError("UNAUTHORIZED", "Too many failed attempts; try again later"),
    );
    return;
  }
  next();
}

export function recordDevAuthFailure(req: Request): void {
  const key = `${req.ip ?? "unknown"}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { failures: 1, resetAt: now + WINDOW_MS });
    return;
  }
  bucket.failures += 1;
}

export function resetDevAuthGuard(): void {
  buckets.clear();
}
