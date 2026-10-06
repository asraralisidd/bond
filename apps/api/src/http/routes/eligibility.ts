/**
 * Eligibility routes (owner-scoped). Witnesses stay operator-side;
 * only validated public intents reach this API.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { ApiError } from "../errors.js";
import { getRequestId } from "../request-id.js";
import {
  fingerprintRequest,
  runIdempotent,
} from "../../services/idempotency.js";
import {
  consumeEligibilityService,
  createEligibilityProofService,
  verifyEligibilityService,
} from "../../services/eligibility.js";

export const eligibilityRouter = Router();

eligibilityRouter.post(
  "/proofs",
  requireAuth,
  rateLimitFor("expensive"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        agentId?: string;
        bondId?: string;
        policyVersion?: string;
        purpose?: string;
        requiredMinimumMinorUnits?: string;
        nonce?: string;
        expiresAt?: string;
        idempotencyKey?: string;
      };
      if (!body.agentId || !body.bondId || !body.nonce || !body.expiresAt) {
        throw new ApiError(
          "INVALID_IDENTIFIER",
          "agentId, bondId, nonce, expiresAt required",
        );
      }
      if (!body.requiredMinimumMinorUnits) {
        throw new ApiError(
          "INVALID_IDENTIFIER",
          "requiredMinimumMinorUnits required",
        );
      }
      const outcome = await runIdempotent({
        key: body.idempotencyKey,
        operatorId: auth.operatorId,
        route: "POST /api/v1/eligibility/proofs",
        fingerprint: fingerprintRequest("POST /api/v1/eligibility/proofs", {
          agentId: body.agentId,
          bondId: body.bondId,
          nonce: body.nonce,
        }),
        execute: async () =>
          createEligibilityProofService({
            operatorId: auth.operatorId,
            agentId: body.agentId as string,
            bondId: body.bondId as string,
            policyVersion: body.policyVersion,
            purpose: body.purpose,
            requiredMinimumMinorUnits: body.requiredMinimumMinorUnits as string,
            nonce: body.nonce as string,
            expiresAt: body.expiresAt as string,
            requestId: getRequestId(req),
          }),
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

eligibilityRouter.get(
  "/proofs/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const view = await verifyEligibilityService({
        proofId: req.params.id as string,
        operatorId: auth.operatorId,
      });
      res.json({ data: view });
    } catch (error) {
      next(error);
    }
  },
);

eligibilityRouter.post(
  "/proofs/:id/consume",
  requireAuth,
  rateLimitFor("expensive"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { nonce?: string };
      if (!body.nonce) {
        throw new ApiError("INVALID_IDENTIFIER", "nonce required");
      }
      const outcome = await consumeEligibilityService({
        proofId: req.params.id as string,
        operatorId: auth.operatorId,
        nonce: body.nonce,
        requestId: getRequestId(req),
      });
      res.json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);
