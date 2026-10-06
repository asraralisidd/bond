/**
 * Agent registry routes (owner-scoped; public reads live under /public).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AgentStatus } from "@bond/shared-types";
import { toAgentPrivateView } from "../dto.js";
import { requireAuth, requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import {
  getAgentService,
  listAgentsService,
  registerAgentService,
  transitionAgentService,
} from "../../services/agents.js";
import {
  fingerprintRequest,
  runIdempotent,
} from "../../services/idempotency.js";
import { getRequestId } from "../request-id.js";

export const agentsRouter = Router();

agentsRouter.post(
  "/",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        platform?: string;
        agentType?: string;
        capabilities?: string[];
        externalRef?: string;
      };
      const outcome = await runIdempotent({
        key: req.headers["idempotency-key"] as string | undefined,
        operatorId: auth.operatorId,
        route: "POST /api/v1/agents",
        fingerprint: fingerprintRequest("POST /api/v1/agents", body),
        execute: async () => {
          const row = await registerAgentService({
            operatorId: auth.operatorId,
            platform: body.platform ?? "",
            agentType: body.agentType ?? "",
            capabilities: body.capabilities ?? [],
            externalRef: body.externalRef ?? "",
            requestId: getRequestId(req),
            actor: `operator:${auth.operatorId}`,
          });
          return toAgentPrivateView(row);
        },
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const limit = Number(req.query.limit ?? 50);
      const rows = await listAgentsService(auth.operatorId, limit);
      res.json({ data: rows.map(toAgentPrivateView) });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const row = await getAgentService(
        req.params.id as string,
        auth.operatorId,
      );
      res.json({ data: toAgentPrivateView(row) });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.patch(
  "/:id/status",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { status?: AgentStatus };
      const row = await transitionAgentService(
        req.params.id as string,
        auth.operatorId,
        body.status as AgentStatus,
        getRequestId(req),
      );
      res.json({ data: toAgentPrivateView(row) });
    } catch (error) {
      next(error);
    }
  },
);
