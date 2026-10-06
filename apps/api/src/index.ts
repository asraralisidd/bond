import cors from "cors";
import express from "express";
import type { HealthResponse } from "@bond/shared-types";
import { loadConfig } from "./config.js";
import { requestIdMiddleware } from "./http/request-id.js";
import { errorHandler } from "./http/errors.js";
import { authRouter } from "./http/routes/auth.js";
import { agentsRouter } from "./http/routes/agents.js";
import { bondsRouter } from "./http/routes/bonds.js";
import { transactionsRouter } from "./http/routes/transactions.js";
import { riskRouter } from "./http/routes/risk.js";
import { eligibilityRouter } from "./http/routes/eligibility.js";
import { publicRouter } from "./http/routes/public.js";
import {
  attestationsRouter,
  attestorsRouter,
} from "./http/routes/attestations.js";
import {
  registerBondExecutors,
  registerBondFinalizers,
} from "./services/executors.js";

const VERSION = "0.1.0";

export function createApp(): express.Express {
  const app = express();
  let corsOrigin = "http://localhost:5173";
  try {
    corsOrigin = loadConfig().corsOrigin;
  } catch {
    // Fall back to safe default when env is not configured (tests).
  }
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());
  app.use(requestIdMiddleware);

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      version: VERSION,
      service: "bond-api",
    };
    res.json(body);
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/agents", agentsRouter);
  app.use("/api/v1/bonds", bondsRouter);
  app.use("/api/v1/transactions", transactionsRouter);
  app.use("/api/v1/risk", riskRouter);
  app.use("/api/v1/eligibility", eligibilityRouter);
  app.use("/api/v1/public", publicRouter);
  app.use("/api/v1/attestations", attestationsRouter);
  app.use("/api/v1/attestors", attestorsRouter);

  app.use(errorHandler);

  registerBondExecutors();
  registerBondFinalizers();

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`bond-api listening on http://${config.host}:${config.port}`);
  });
}
