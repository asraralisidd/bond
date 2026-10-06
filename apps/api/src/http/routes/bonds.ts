/**
 * Bond routes (owner-scoped). Creation/lock intents persist immediately;
 * chain submission happens through transaction records (7.8).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { BondStatus } from "@bond/shared-types";
import { toBondPrivateView } from "../dto.js";
import { requireAuth, requireOperator } from "../auth.js";
import {
  createBondService,
  getBondService,
  transitionBondService,
} from "../../services/bonds.js";
import {
  fingerprintRequest,
  runIdempotent,
} from "../../services/idempotency.js";
import { getRequestId } from "../request-id.js";

export const bondsRouter = Router();

bondsRouter.post(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        agentId?: string;
        commitmentMinorUnits?: string;
      };
      const outcome = await runIdempotent({
        key: req.headers["idempotency-key"] as string | undefined,
        operatorId: auth.operatorId,
        route: "POST /api/v1/bonds",
        fingerprint: fingerprintRequest("POST /api/v1/bonds", body),
        execute: async () => {
          const created = await createBondService({
            operatorId: auth.operatorId,
            agentId: body.agentId ?? "",
            commitmentMinorUnits: body.commitmentMinorUnits ?? "",
            requestId: getRequestId(req),
          });
          return toBondPrivateView(created);
        },
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

bondsRouter.get(
  "/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const row = await getBondService(
        req.params.id as string,
        auth.operatorId,
      );
      res.json({ data: toBondPrivateView(row) });
    } catch (error) {
      next(error);
    }
  },
);

bondsRouter.patch(
  "/:id/status",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { status?: BondStatus };
      const row = await transitionBondService(
        req.params.id as string,
        auth.operatorId,
        body.status as BondStatus,
        getRequestId(req),
      );
      res.json({ data: toBondPrivateView(row) });
    } catch (error) {
      next(error);
    }
  },
);
