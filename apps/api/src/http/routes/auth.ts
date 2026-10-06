/**
 * Development session issuance. INTERIM: pre-shared dev key only.
 * Wallet-signature login is blocked (Phase 5 Lace shape unresolved).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  checkDevKey,
  issueDevSession,
  requireAuth,
  requireOperator,
} from "../auth.js";
import {
  devBruteForceGuard,
  recordDevAuthFailure,
} from "../middleware/dev-guard.js";
import { revokeSession } from "../../db/stores/operators.js";
import { ApiError } from "../errors.js";

export const authRouter = Router();

authRouter.post(
  "/session",
  devBruteForceGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { devKey?: string; externalKey?: string };
      try {
        checkDevKey(body.devKey);
      } catch (error) {
        recordDevAuthFailure(req);
        throw error;
      }
      if (!body.externalKey || typeof body.externalKey !== "string") {
        throw new ApiError("INVALID_IDENTIFIER", "externalKey required");
      }
      const session = await issueDevSession(body.externalKey);
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  },
);

authRouter.post(
  "/sign-out",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      await revokeSession(auth.sessionId);
      res.json({ data: { signedOut: true } });
    } catch (error) {
      next(error);
    }
  },
);
