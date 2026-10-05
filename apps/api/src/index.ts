import cors from "cors";
import express from "express";
import type { HealthResponse } from "@bond/shared-types";

const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const VERSION = "0.1.0";

export function createApp(): express.Express {
  const app = express();
  app.use(cors({ origin: CORS_ORIGIN }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      version: VERSION,
      service: "bond-api",
    };
    res.json(body);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`bond-api listening on http://${HOST}:${PORT}`);
  });
}
