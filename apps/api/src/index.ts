import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { HealthResponse } from "@bond/shared-types";
import { loadConfig } from "./config.js";
import type { ApiConfig } from "./config.js";
import { requestIdMiddleware } from "./http/request-id.js";
import { errorHandler } from "./http/errors.js";
import { notFoundHandler } from "./http/middleware/not-found.js";
import { timeoutMiddleware } from "./http/middleware/timeout.js";
import { authRouter } from "./http/routes/auth.js";
import { agentsRouter } from "./http/routes/agents.js";
import { bondsRouter } from "./http/routes/bonds.js";
import { transactionsRouter } from "./http/routes/transactions.js";
import { riskRouter } from "./http/routes/risk.js";
import { eligibilityRouter } from "./http/routes/eligibility.js";
import { publicRouter } from "./http/routes/public.js";
import { readyHandler } from "./http/routes/system.js";
import {
  attestationsRouter,
  attestorsRouter,
} from "./http/routes/attestations.js";
import {
  registerBondExecutors,
  registerBondFinalizers,
} from "./services/executors.js";
import { closePool } from "./db/pool.js";
import {
  createShutdownController,
  installProcessHandlers,
  serverCloser,
} from "./shutdown.js";
import { ApiError } from "./http/errors.js";

const VERSION = "0.1.0";

const FALLBACK_CONFIG: ApiConfig = {
  nodeEnv: "development",
  port: 4000,
  host: "0.0.0.0",
  corsOrigins: ["http://localhost:5173"],
  bodyLimit: "100kb",
  requestTimeoutMs: 30000,
  shutdownTimeoutMs: 10000,
  databaseUrl: "",
  logLevel: "info",
  midnightNetwork: "",
  devAuthToken: null,
};

function loadConfigSafe(): ApiConfig {
  try {
    return loadConfig();
  } catch {
    // Safe defaults when env is not configured (tests).
    return FALLBACK_CONFIG;
  }
}

export function createApp(): express.Express {
  const config = loadConfigSafe();
  const app = express();

  // 1. Security headers first (before any response is shaped).
  app.use(
    helmet({
      // No inline scripts/styles in the API; the SPA is served separately.
      // Keep CSP report-only-off and default-safe for a JSON API.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // 2. CORS allowlist (explicit origins only — never '*').
  app.use(
    cors({
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void,
      ) => {
        if (origin === undefined) {
          callback(null, true);
          return;
        }
        if (config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new ApiError("FORBIDDEN", "Origin not allowed"));
      },
    }),
  );
  // 3. Bounded JSON bodies.
  app.use(express.json({ limit: config.bodyLimit }));
  // 4. Request correlation.
  app.use(requestIdMiddleware);
  // 5. Bounded HTTP responses (ends the response only — see module docs).
  app.use(timeoutMiddleware(config.requestTimeoutMs));

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      version: VERSION,
      service: "bond-api",
    };
    res.json(body);
  });

  app.get("/ready", readyHandler);

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/agents", agentsRouter);
  app.use("/api/v1/bonds", bondsRouter);
  app.use("/api/v1/transactions", transactionsRouter);
  app.use("/api/v1/risk", riskRouter);
  app.use("/api/v1/eligibility", eligibilityRouter);
  app.use("/api/v1/public", publicRouter);
  app.use("/api/v1/attestations", attestationsRouter);
  app.use("/api/v1/attestors", attestorsRouter);

  // 6. JSON 404 for everything unmatched (never Express HTML).
  app.use(notFoundHandler);
  // 7. Centralized sanitized errors, last.
  app.use(errorHandler);

  registerBondExecutors();
  registerBondFinalizers();

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`bond-api listening on http://${config.host}:${config.port}`);
  });
  const controller = createShutdownController({
    closeServer: serverCloser(server),
    closePool,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    onLog: (message: string) => console.log(message),
    exit: (code: number) => process.exit(code),
  });
  installProcessHandlers(
    process,
    (signal: string) => controller.shutdown(signal),
    (message: string) => console.log(message),
  );
}
