/**
 * Client identity for rate limiting.
 *
 * - Authenticated operator traffic is keyed by operator ID (set by
 *   per-route middleware, after requireAuth).
 * - Everyone else is keyed by client IP.
 * - Forwarded headers are honored ONLY when TRUST_PROXY=true; otherwise
 *   the direct socket address is used. Never trust X-Forwarded-For from
 *   arbitrary clients (spoofable → bucket evasion or bucket poisoning).
 */
import type { Request } from "express";

export interface ProxyConfig {
  readonly trustProxy: boolean;
}

function firstForwardedAddress(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const first = header.split(",")[0]?.trim() ?? "";
  // Conservative: accept IPv4/IPv6-ish tokens of bounded length only.
  if (first.length === 0 || first.length > 64) {
    return null;
  }
  if (!/^[0-9a-zA-Z.:%_-]+$/.test(first)) {
    return null;
  }
  return first;
}

export function clientIp(req: Request, config: ProxyConfig): string {
  if (config.trustProxy) {
    const forwarded = firstForwardedAddress(
      req.headers["x-forwarded-for"] as string | undefined,
    );
    if (forwarded) {
      return forwarded;
    }
  }
  const socketAddr =
    (req.socket?.remoteAddress as string | undefined) ??
    (req.ip as string | undefined) ??
    "unknown";
  return socketAddr.length > 0 ? socketAddr : "unknown";
}

/** Operator-scoped bucket; falls back to IP when unauthenticated. */
export function operatorKey(operatorId: string): string {
  return `op:${operatorId}`;
}

/**
 * Agent-scoped bucket, separate from the owning operator's bucket: a
 * compromised or chatty agent cannot burn its operator's budget and
 * one agent's flood does not punish siblings.
 */
export function agentKey(agentId: string): string {
  return `agent:${agentId}`;
}

export function publicKey(ip: string): string {
  return `pub:${ip}`;
}

/** Auth attempts: IP + credential target (never the secret itself). */
export function authAttemptKey(ip: string, target: string): string {
  const safe = target.length > 128 ? target.slice(0, 128) : target;
  return `auth:${ip}:${safe}`;
}
