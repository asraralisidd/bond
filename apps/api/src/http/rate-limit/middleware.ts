/**
 * Rate-limit middleware: global IP baseline + per-route identity-aware.
 *
 * Global (`globalRateLimit`): runs before authentication, keyed by
 * client IP — covers session issuance, public verification, and a
 * generous read baseline. Mutations return null from classification
 * and are covered per-route after auth instead.
 *
 * Per-route (`rateLimitFor`): runs after requireAuth/requireAttestor
 * and keys by operator ID (or a caller-supplied key, e.g. attestor).
 * Falls back to IP when no identity is present — never fails open,
 * never fails closed spuriously.
 *
 * Denials always carry the request id, Retry-After, and limit headers,
 * and are logged without keys, tokens, or secrets.
 */
import type { Request, Response, NextFunction } from "express";
import { emptyLogMetadata } from "@bond/shared-types";
import { logInfo } from "../../observability.js";
import type { RateLimitConfig, PolicyName } from "./policies.js";
import { classifyRequest } from "./policies.js";
import { rateLimitDeps } from "./registry.js";
import type { RateLimitStore } from "./store.js";
import {
  agentKey,
  authAttemptKey,
  clientIp,
  operatorKey,
  publicKey,
} from "./identity.js";

export interface RateLimitMiddlewareDeps {
  readonly store: RateLimitStore;
  readonly config: RateLimitConfig;
  readonly clock?: () => number;
}

type ResolvedDeps = Required<RateLimitMiddlewareDeps>;

function resolveDeps(deps?: RateLimitMiddlewareDeps): ResolvedDeps {
  if (deps) {
    return { clock: Date.now, ...deps };
  }
  // NOTE: callers invoke this per request, never at module load, so the
  // registration always reflects the owning application instance.
  return { ...rateLimitDeps() };
}

function deny(
  res: Response,
  requestId: string | null,
  decision: { limit: number; retryAfterSeconds: number },
  operation: string,
): void {
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  res.setHeader("X-RateLimit-Limit", String(decision.limit));
  res.setHeader("X-RateLimit-Remaining", "0");
  logInfo(
    {
      metadata: { ...emptyLogMetadata(), requestId },
      operation: "rate-limit-exceeded",
      errorCode: "RATE_LIMITED",
    },
    `${operation} rejected by rate limit`,
  );
  res.status(429).json({
    code: "RATE_LIMITED",
    message: "Too many requests; try again later",
    requestId,
  });
}

function requestIdOf(req: Request): string | null {
  const value = req.headers["x-request-id"];
  return typeof value === "string" ? value : null;
}

export function globalRateLimit(deps?: RateLimitMiddlewareDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resolved = resolveDeps(deps);
    const now = resolved.clock ?? Date.now;
    if (!resolved.config.enabled) {
      next();
      return;
    }
    const policyName = classifyRequest(req.method, req.path);
    if (policyName === null) {
      next();
      return;
    }
    const policy = resolved.config.policies[policyName];
    let key: string;
    if (policyName === "auth") {
      const body = req.body as { externalKey?: unknown } | undefined;
      const target =
        typeof body?.externalKey === "string" ? body.externalKey : "";
      key = `${policyName}:${authAttemptKey(clientIp(req, resolved.config), target)}`;
    } else {
      key = `${policyName}:${publicKey(clientIp(req, resolved.config))}`;
    }
    const decision = resolved.store.checkAndConsume(key, policy, now());
    res.setHeader("X-RateLimit-Limit", String(decision.limit));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      deny(res, requestIdOf(req), decision, `global:${policyName}`);
      return;
    }
    next();
  };
}

export function rateLimitFor(
  policyName: Exclude<PolicyName, "auth" | "public" | "publicEligibility">,
  keyFn?: (req: Request) => string | null,
  deps?: RateLimitMiddlewareDeps,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resolved = resolveDeps(deps);
    const now = resolved.clock ?? Date.now;
    if (!resolved.config.enabled) {
      next();
      return;
    }
    const policy = resolved.config.policies[policyName];
    const agentId = req.auth?.agent?.agentId;
    const operatorId = req.auth?.operatorId;
    const identity =
      agentId !== undefined && agentId !== ""
        ? agentKey(agentId)
        : operatorId !== undefined && operatorId !== ""
          ? operatorKey(operatorId)
          : (keyFn?.(req) ?? publicKey(clientIp(req, resolved.config)));
    const key = `${policyName}:${identity}`;
    const decision = resolved.store.checkAndConsume(key, policy, now());
    res.setHeader("X-RateLimit-Limit", String(decision.limit));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      deny(res, requestIdOf(req), decision, `route:${policyName}`);
      return;
    }
    next();
  };
}
