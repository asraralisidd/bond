/**
 * Controlled shutdown: stop accepting connections, allow a bounded
 * grace period for in-flight requests, close the DB pool, exit cleanly.
 *
 * Testable by design: ShutdownController takes injected server/pool
 * doubles — no process.exit() in business logic, no real signals needed
 * in tests. Repeated signals force a faster exit path.
 */
import type { Server } from "node:http";

export interface ShutdownDeps {
  readonly closeServer: () => Promise<void>;
  readonly closePool: () => Promise<void>;
  readonly shutdownTimeoutMs: number;
  readonly onLog: (message: string) => void;
  readonly exit: (code: number) => void;
  /**
   * Optional drain hook (e.g. background worker stop). Runs first inside
   * the grace period; failures are logged, never fatal to shutdown.
   */
  readonly onDrainStart?: () => Promise<void>;
}

export type ShutdownPhase = "running" | "draining" | "done";

export function createShutdownController(deps: ShutdownDeps): {
  readonly phase: () => ShutdownPhase;
  readonly shutdown: (signal: string) => Promise<void>;
} {
  let phase: ShutdownPhase = "running";

  async function shutdown(signal: string): Promise<void> {
    if (phase === "done") {
      return;
    }
    if (phase === "draining") {
      deps.onLog(
        `Shutdown already in progress (received ${signal}); forcing exit`,
      );
      deps.exit(1);
      return;
    }
    phase = "draining";
    deps.onLog(`Shutdown initiated by ${signal}; draining connections`);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), deps.shutdownTimeoutMs);
      timer.unref?.();
    });
    await Promise.race([
      (async () => {
        if (deps.onDrainStart) {
          try {
            await deps.onDrainStart();
          } catch (error) {
            deps.onLog(
              `Error in drain hook: ${error instanceof Error ? error.message : "unknown"}`,
            );
          }
        }
        try {
          await deps.closeServer();
        } catch (error) {
          deps.onLog(
            `Error closing server: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
        try {
          await deps.closePool();
        } catch (error) {
          deps.onLog(
            `Error closing pool: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      })(),
      timeout,
    ]);
    phase = "done";
    deps.onLog("Shutdown complete");
    deps.exit(0);
  }

  return { phase: () => phase, shutdown };
}

export function serverCloser(server: Server): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
}

/**
 * Wires process-level handlers. Called once from the entrypoint only.
 * uncaughtException triggers controlled shutdown (the process is not
 * trusted to continue); unhandledRejection is logged and also drains,
 * since an unobserved rejection means unknown state.
 */
export function installProcessHandlers(
  proc: NodeJS.Process,
  shutdown: (signal: string) => Promise<void>,
  onLog: (message: string) => void,
): void {
  let shuttingDown = false;
  const begin = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown(signal).catch(() => {
      onLog("Shutdown handler failed");
    });
  };
  proc.on("SIGTERM", () => begin("SIGTERM"));
  proc.on("SIGINT", () => begin("SIGINT"));
  proc.on("uncaughtException", (error: unknown) => {
    onLog(
      `uncaughtException: ${error instanceof Error ? error.message.slice(0, 500) : "unknown"}`,
    );
    begin("uncaughtException");
  });
  proc.on("unhandledRejection", (reason: unknown) => {
    onLog(
      `unhandledRejection: ${reason instanceof Error ? reason.message.slice(0, 500) : "unknown"}`,
    );
    begin("unhandledRejection");
  });
}
