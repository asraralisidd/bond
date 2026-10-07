/**
 * Delegation detail routes (Phase 23).
 * Mounted at /api/v1/delegations. Reads are permitted to the
 * delegator, the delegate, and operators owning either side;
 * revocation belongs to the delegator (agent) or its operator.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  requireAgentOrOperator,
  requireAuthContext,
} from "../middleware/agent-auth.js";
import { requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { getRequestId } from "../request-id.js";
import {
  getDelegationService,
  revokeDelegationService,
} from "../../services/delegations.js";

export const delegationsRouter = Router();

delegationsRouter.get(
  "/:id",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      const view = await getDelegationService({
        operatorId: auth.operatorId,
        creatorAgentId: auth.agent?.agentId,
        delegationId: req.params.id as string,
      });
      res.json({ data: view });
    } catch (error) {
      next(error);
    }
  },
);

delegationsRouter.post(
  "/:id/revoke",
  requireAgentOrOperator,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      // Operator path must prove operator principal: agent
      // principals carry auth.agent and revoke as themselves.
      if (auth.agent === undefined) {
        requireOperator(req);
      }
      const body = req.body as { reason?: unknown };
      const view = await revokeDelegationService({
        operatorId: auth.operatorId,
        creatorAgentId: auth.agent?.agentId,
        delegationId: req.params.id as string,
        reason: body.reason,
        requestId: getRequestId(req),
      });
      res.json({ data: view });
    } catch (error) {
      next(error);
    }
  },
);
