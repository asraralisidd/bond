/**
 * Session issuance: interim dev key (dev only) + wallet challenge-response.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  checkDevKey,
  issueDevSession,
  requireAuth,
  requireOperator,
} from "../auth.js";
import { revokeSession } from "../../db/stores/operators.js";
import {
  requestWalletChallenge,
  verifyWalletChallenge,
} from "../../services/wallet-auth.js";
import { ApiError } from "../errors.js";

export const authRouter = Router();

// NOTE: brute-force protection for this endpoint now comes from the
// global auth rate-limit policy (IP + credential target), which
// supersedes the old development-only per-process guard.
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

// Wallet challenge-response login (production path).
authRouter.post(
  "/wallet/challenge",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { network?: unknown };
      const challenge = await requestWalletChallenge({
        network: body.network,
      });
      res.status(201).json({ data: challenge });
    } catch (error) {
      next(error);
    }
  },
);

authRouter.post(
  "/wallet/verify",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        challengeId?: unknown;
        signature?: unknown;
      };
      const session = await verifyWalletChallenge({
        challengeId: body.challengeId,
        signature: body.signature,
      });
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  },
);
