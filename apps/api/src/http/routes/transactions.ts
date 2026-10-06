/**
 * Transaction routes: intent creation (idempotent), status reads, and
 * explicit confirmation. Status truth comes from rows advanced only by
 * the worker (finality) or explicit operator confirm (SIMULATED dev).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { TransactionPurpose, TransactionStatus } from "@bond/shared-types";
import { connectMidnight, resolveMidnightConfig } from "@bond/midnight-adapter";
import { requireAuth, requireOperator } from "../auth.js";
import { ApiError } from "../errors.js";
import { getRequestId } from "../request-id.js";
import {
  fingerprintRequest,
  runIdempotent,
} from "../../services/idempotency.js";
import {
  advanceTransactionService,
  confirmTransactionService,
  createTransactionIntent,
  getTransactionService,
} from "../../services/transactions.js";

export const transactionsRouter = Router();

transactionsRouter.post(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        purpose?: TransactionPurpose;
        agentId?: string;
        bondId?: string;
        idempotencyKey?: string;
        nullifier?: string;
      };
      if (!body.idempotencyKey) {
        throw new ApiError("INVALID_IDENTIFIER", "idempotencyKey required");
      }
      const outcome = await runIdempotent({
        key: body.idempotencyKey,
        operatorId: auth.operatorId,
        route: "POST /api/v1/transactions",
        fingerprint: fingerprintRequest("POST /api/v1/transactions", {
          purpose: body.purpose,
          agentId: body.agentId,
          bondId: body.bondId,
        }),
        execute: async () => {
          const { row } = await createTransactionIntent({
            operatorId: auth.operatorId,
            purpose: body.purpose as TransactionPurpose,
            agentId: body.agentId,
            bondId: body.bondId,
            idempotencyKey: body.idempotencyKey as string,
            nullifier: body.nullifier,
            requestId: getRequestId(req),
          });
          return {
            transactionId: row.id,
            purpose: row.purpose,
            status: row.status,
          };
        },
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

transactionsRouter.get(
  "/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireOperator(req);
      const row = await getTransactionService(req.params.id as string);
      res.json({
        data: {
          transactionId: row.id,
          purpose: row.purpose,
          agentId: row.agent_id,
          bondId: row.bond_id,
          status: row.status,
          chainTxId: row.chain_tx_id,
          confirmedAt: row.confirmed_at,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

transactionsRouter.post(
  "/:id/advance",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { status?: TransactionStatus };
      const row = await advanceTransactionService(
        req.params.id as string,
        body.status as TransactionStatus,
        `operator:${auth.operatorId}`,
        getRequestId(req),
      );
      res.json({ data: { transactionId: row.id, status: row.status } });
    } catch (error) {
      next(error);
    }
  },
);

transactionsRouter.post(
  "/:id/confirm",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const handle = connectMidnight(resolveMidnightConfig(process.env));
      const row = await confirmTransactionService(
        req.params.id as string,
        handle,
        `operator:${auth.operatorId}`,
        getRequestId(req),
      );
      res.json({ data: { transactionId: row.id, status: row.status } });
    } catch (error) {
      next(error);
    }
  },
);
