/**
 * Rate-limiter composition root.
 *
 * `createApp` builds one store + config per application instance and
 * registers them here; route-level `rateLimitFor` factories read the
 * current registration. Per-app instances keep tests isolated; in
 * production there is exactly one registration per process.
 */
import type { RateLimitConfig } from "./policies.js";
import { resolveRateLimitConfig } from "./policies.js";
import { MemoryRateLimitStore } from "./store.js";
import type { RateLimitStore } from "./store.js";

export interface RateLimitDeps {
  readonly store: RateLimitStore;
  readonly config: RateLimitConfig;
  readonly clock: () => number;
}

let current: RateLimitDeps | null = null;

export function configureRateLimiting(
  overrides?: Partial<RateLimitDeps>,
): RateLimitDeps {
  const config = overrides?.config ?? resolveRateLimitConfig();
  const deps: RateLimitDeps = {
    store: overrides?.store ?? new MemoryRateLimitStore(),
    config,
    clock: overrides?.clock ?? Date.now,
  };
  current = deps;
  return deps;
}

export function rateLimitDeps(): RateLimitDeps {
  if (!current) {
    return configureRateLimiting();
  }
  return current;
}

/** Test escape hatch: drop the registration between cases. */
export function resetRateLimiting(): void {
  current = null;
}
