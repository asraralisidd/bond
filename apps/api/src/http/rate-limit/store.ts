/**
 * Rate-limit storage abstraction.
 *
 * Policy (limits, windows) is separate from storage so a future
 * multi-replica deployment can swap MemoryRateLimitStore for a shared
 * store without touching route or authorization logic.
 */
export interface RateLimitPolicy {
  readonly name: string;
  readonly max: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly resetAt: number;
}

export interface RateLimitStore {
  checkAndConsume(
    key: string,
    policy: RateLimitPolicy,
    now: number,
  ): RateLimitDecision;
  size(): number;
  prune(now: number): number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Process-local fixed-window store.
 *
 * Bounded: at most `maxKeys` buckets; when exceeded, expired buckets
 * are swept first, then oldest-inserted entries are evicted. An
 * attacker minting unlimited distinct keys therefore cannot grow
 * memory without bound — worst case they evict each other.
 *
 * NOT a distributed solution: each process enforces independently.
 * Multi-replica deployments need a shared store behind this interface.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(maxKeys = 10000) {
    if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
      throw new Error(`Invalid rate-limit maxKeys: ${maxKeys}`);
    }
    this.maxKeys = maxKeys;
  }

  checkAndConsume(
    key: string,
    policy: RateLimitPolicy,
    now: number,
  ): RateLimitDecision {
    this.evictIfNeeded(now, policy.windowMs);
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= policy.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= policy.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.windowStart + policy.windowMs - now) / 1000),
      );
      return {
        allowed: false,
        limit: policy.max,
        remaining: 0,
        retryAfterSeconds,
        resetAt: bucket.windowStart + policy.windowMs,
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      limit: policy.max,
      remaining: policy.max - bucket.count,
      retryAfterSeconds: 0,
      resetAt: bucket.windowStart + policy.windowMs,
    };
  }

  size(): number {
    return this.buckets.size;
  }

  prune(now: number): number {
    // Default window unknown here; callers pass policy windows via
    // checkAndConsume sweeps. prune() removes buckets idle > 24h as a
    // backstop using stored window starts.
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > 24 * 60 * 60 * 1000) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private evictIfNeeded(now: number, windowMs: number): void {
    if (this.buckets.size < this.maxKeys) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= windowMs) {
        this.buckets.delete(key);
        if (this.buckets.size < this.maxKeys) {
          return;
        }
      }
    }
    // Still over budget: evict oldest-inserted first (Map preserves
    // insertion order). Attackers churning keys evict each other, and
    // legitimate buckets are recreated on next use.
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (this.buckets.size < this.maxKeys) {
        return;
      }
    }
  }
}
