/**
 * Development session issuance. INTERIM: pre-shared dev key only.
 * Wallet-signature login is blocked (Phase 5 Lace shape unresolved).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { checkDevKey, issueDevSession } from "../auth.js";
import { ApiError } from "../errors.js";

export const authRouter = Router();

authRouter.post(
  "/session",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { devKey?: string; externalKey?: string };
      checkDevKey(body.devKey);
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
