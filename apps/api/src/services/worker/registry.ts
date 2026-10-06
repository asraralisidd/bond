/**
 * Worker singleton registry: one runtime per API process, created from
 * the environment on first start. Readiness reports its snapshot;
 * tests construct isolated runtimes directly instead.
 */
import {
  connectMidnight,
  connectReadOnly,
  resolveMidnightConfig,
} from "@bond/midnight-adapter";
import type { ChainHandle } from "@bond/midnight-adapter";
import { createWorkerRuntime } from "./runtime.js";
import type { WorkerRuntime } from "./runtime.js";
import { resolveWorkerConfig } from "./config.js";
import type { WorkerSnapshot } from "./types.js";

let runtime: WorkerRuntime | null = null;

export function startWorkerFromEnv(): WorkerRuntime | null {
  if (runtime) {
    return runtime;
  }
  const config = resolveWorkerConfig();
  if (!config.enabled) {
    return null;
  }
  const created = createWorkerRuntime({
    config,
    resolveHandle: (): ChainHandle | null => {
      try {
        const midnight = resolveMidnightConfig();
        // Phase 12: non-custodial observation handle. Submission still
        // requires the operator wallet (never the worker); finality reads
        // work through the read-only provider bundle, whose wallet stub
        // refuses every signing/submission call. connectMidnight without
        // an injected wallet throws by design — that throw is what we
        // catch below, so try the read-only path first.
        if (midnight.mode === "REAL") {
          return connectReadOnly(midnight);
        }
        return connectMidnight(midnight);
      } catch {
        return null;
      }
    },
    contractAddress: process.env.BOND_CONTRACT_ADDRESS?.trim() || null,
  });
  runtime = created;
  created.start();
  return created;
}

export function getWorkerSnapshot(): WorkerSnapshot | null {
  return runtime?.snapshot() ?? null;
}

export async function stopWorker(): Promise<void> {
  if (runtime) {
    await runtime.stop();
    runtime = null;
  }
}

/** Test hook: reset the singleton between isolated cases. */
export function resetWorkerRegistry(): void {
  runtime = null;
}
