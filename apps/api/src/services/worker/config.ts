/**
 * Worker configuration: validated bounds for the background job loop.
 * Disabled is a safe, supported mode (API serves traffic; no background
 * submission, confirmation, or reconciliation occurs).
 */
import { loadConfig } from "../../config.js";

export interface WorkerConfig {
  readonly enabled: boolean;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly submittedReconcileAfterMs: number;
  readonly reconcileIntervalMs: number;
  readonly reconcileBatchLimit: number;
  readonly contractAddress: string | null;
}

export function resolveWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  // Reuses the validated ApiConfig parsers by delegating to loadConfig,
  // so worker bounds share one validation story with the API.
  const config = loadConfig(env);
  return {
    enabled: config.workerEnabled,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.workerPollIntervalMs,
    leaseMs: config.workerLeaseMs,
    maxAttempts: config.workerMaxAttempts,
    backoffBaseMs: config.workerBackoffBaseMs,
    backoffMaxMs: config.workerBackoffMaxMs,
    submittedReconcileAfterMs: config.workerSubmittedReconcileAfterMs,
    reconcileIntervalMs: config.workerReconcileIntervalMs,
    reconcileBatchLimit: 50,
    contractAddress: env.BOND_CONTRACT_ADDRESS?.trim() || null,
  };
}
