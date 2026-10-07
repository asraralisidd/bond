/**
 * Setup grant management (Phase 19, OPERATOR ONLY).
 *
 * Raw secrets appear exactly once: the create response. List responses
 * carry metadata only. Agents and grants can never call these routes
 * (requireOperator rejects both non-operator principals).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { getRequestId } from "../request-id.js";
import { ApiError } from "../errors.js";
import {
  createSetupGrantService,
  listSetupGrantsService,
  revokeSetupGrantService,
} from "../../services/setup-grants.js";

export const setupGrantsRouter = Router();

setupGrantsRouter.post(
  "/",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        agentId?: unknown;
        scopes?: unknown;
        expiresAt?: unknown;
      };
      const outcome = await createSetupGrantService({
        operatorId: auth.operatorId,
        agentId: body.agentId,
        scopes: body.scopes,
        expiresAt: body.expiresAt,
        requestId: getRequestId(req),
      });
      res.status(201).json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

setupGrantsRouter.get(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const rows = await listSetupGrantsService({
        operatorId: auth.operatorId,
      });
      res.json({ data: rows });
    } catch (error) {
      next(error);
    }
  },
);

setupGrantsRouter.delete(
  "/:grantId",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const grantId = req.params.grantId as string;
      if (!grantId) {
        throw new ApiError("INVALID_IDENTIFIER", "Grant id required");
      }
      const body = req.body as { reason?: unknown } | undefined;
      const row = await revokeSetupGrantService({
        operatorId: auth.operatorId,
        grantId,
        reason: body?.reason,
        requestId: getRequestId(req),
      });
      res.json({ data: { revoked: true, grantId: row.grantId } });
    } catch (error) {
      next(error);
    }
  },
);
