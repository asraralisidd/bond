/**
 * Agent credential management (Phase 18, OPERATOR ONLY).
 *
 * Raw secrets appear exactly twice in the API: create and rotate
 * responses. List/get responses carry metadata only. Agents can never
 * call these routes (requireOperator rejects agent principals).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { getRequestId } from "../request-id.js";
import { ApiError } from "../errors.js";
import {
  createAgentCredentialService,
  listAgentCredentialsService,
  rotateAgentCredentialService,
  revokeAgentCredentialService,
} from "../../services/agent-credentials.js";

export const agentCredentialsRouter = Router({ mergeParams: true });

agentCredentialsRouter.post(
  "/",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        capabilities?: unknown;
        expiresAt?: unknown;
      };
      const agentId = req.params.id as string;
      if (!agentId) {
        throw new ApiError("INVALID_IDENTIFIER", "Agent id required");
      }
      const outcome = await createAgentCredentialService({
        operatorId: auth.operatorId,
        agentId,
        capabilities: body.capabilities,
        expiresAt: body.expiresAt,
        requestId: getRequestId(req),
      });
      res.status(201).json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

agentCredentialsRouter.get(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const agentId = req.params.id as string;
      if (!agentId) {
        throw new ApiError("INVALID_IDENTIFIER", "Agent id required");
      }
      const rows = await listAgentCredentialsService({
        operatorId: auth.operatorId,
        agentId,
      });
      res.json({ data: rows });
    } catch (error) {
      next(error);
    }
  },
);

agentCredentialsRouter.post(
  "/:credentialId/rotate",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const agentId = req.params.id as string;
      const credentialId = req.params.credentialId as string;
      if (!agentId || !credentialId) {
        throw new ApiError("INVALID_IDENTIFIER", "Agent id required");
      }
      const outcome = await rotateAgentCredentialService({
        operatorId: auth.operatorId,
        agentId,
        credentialId,
        requestId: getRequestId(req),
      });
      res.status(201).json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

agentCredentialsRouter.delete(
  "/:credentialId",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const agentId = req.params.id as string;
      const credentialId = req.params.credentialId as string;
      if (!agentId || !credentialId) {
        throw new ApiError("INVALID_IDENTIFIER", "Agent id required");
      }
      const body = req.body as { reason?: unknown } | undefined;
      const row = await revokeAgentCredentialService({
        operatorId: auth.operatorId,
        agentId,
        credentialId,
        reason: body?.reason,
        requestId: getRequestId(req),
      });
      res.json({ data: { revoked: true, credentialId: row.credentialId } });
    } catch (error) {
      next(error);
    }
  },
);
