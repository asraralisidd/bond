/**
 * Attestation routes: registry (operator), requests, verdicts (attestor
 * credential), auto-evaluation, reads, and explicit enforcement intents.
 * Nothing here submits to chain — enforcement creates a transaction
 * intent processed like any other.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AttestationVerdict } from "@bond/shared-types";
import { requireAuth, requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { requireAttestor } from "../middleware/attestor-auth.js";
import { ApiError } from "../errors.js";
import { getRequestId } from "../request-id.js";
import {
  fingerprintRequest,
  runIdempotent,
} from "../../services/idempotency.js";
import {
  requireAttestationOwnership,
  requireFlagOwnership,
} from "../../services/authorization.js";
import {
  autoEvaluateService,
  buildDecisionFromAttestation,
  getAttestationService,
  issueDecisionService,
  registerAttestorService,
  requestAttestationService,
  submitVerdictService,
} from "../../services/attestations.js";
import { createTransactionIntent } from "../../services/transactions.js";
import { findLiveBondByAgent } from "../../db/stores/registry.js";

export const attestationsRouter = Router();
export const attestorsRouter = Router();

attestorsRouter.post(
  "/",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        attestorId?: string;
        organization?: string;
        secret?: string;
      };
      const created = await registerAttestorService({
        operatorId: auth.operatorId,
        attestorId: body.attestorId,
        organization: body.organization ?? "",
        secret: body.secret ?? "",
      });
      void auth;
      res.status(201).json({ data: created });
    } catch (error) {
      next(error);
    }
  },
);

attestationsRouter.post(
  "/",
  requireAuth,
  rateLimitFor("attestation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        flagId?: string;
        attestorIds?: string[];
        threshold?: number;
        expiresAt?: string;
        idempotencyKey?: string;
      };
      if (!body.flagId || !body.expiresAt) {
        throw new ApiError(
          "INVALID_IDENTIFIER",
          "flagId and expiresAt required",
        );
      }
      await requireFlagOwnership(body.flagId, auth.operatorId);
      const outcome = await runIdempotent({
        key: body.idempotencyKey,
        operatorId: auth.operatorId,
        route: "POST /api/v1/attestations",
        fingerprint: fingerprintRequest("POST /api/v1/attestations", {
          flagId: body.flagId,
          attestorIds: body.attestorIds,
        }),
        execute: async () =>
          requestAttestationService({
            operatorId: auth.operatorId,
            flagId: body.flagId as string,
            attestorIds: body.attestorIds ?? [],
            threshold: body.threshold,
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

attestationsRouter.get(
  "/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      await requireAttestationOwnership(
        req.params.id as string,
        auth.operatorId,
      );
      const view = await getAttestationService(req.params.id as string);
      res.json({ data: view });
    } catch (error) {
      next(error);
    }
  },
);

attestationsRouter.post(
  "/:id/verdicts",
  requireAttestor,
  rateLimitFor("attestation", (req) => {
    const b = req.body as { attestorId?: unknown } | undefined;
    return typeof b?.attestorId === "string" && b.attestorId !== ""
      ? `attestor:${b.attestorId}`
      : null;
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        attestorId?: string;
        verdict?: AttestationVerdict;
        issuedAt?: string;
      };
      const secret =
        typeof req.headers["x-attestor-secret"] === "string"
          ? (req.headers["x-attestor-secret"] as string)
          : undefined;
      if (!body.attestorId) {
        throw new ApiError("INVALID_IDENTIFIER", "attestorId required");
      }
      if (req.attestorId !== undefined && req.attestorId !== body.attestorId) {
        throw new ApiError("FORBIDDEN", "Attestor identity mismatch");
      }
      const outcome = await submitVerdictService({
        attestationId: req.params.id as string,
        attestorId: body.attestorId,
        verdict: body.verdict as AttestationVerdict,
        secret,
        issuedAt: body.issuedAt,
        requestId: getRequestId(req),
      });
      res.status(201).json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

attestationsRouter.post(
  "/:id/evaluate",
  requireAuth,
  rateLimitFor("attestation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { strictness?: number };
      await requireAttestationOwnership(
        req.params.id as string,
        auth.operatorId,
      );
      const outcome = await autoEvaluateService({
        attestationId: req.params.id as string,
        operatorId: auth.operatorId,
        strictness: body.strictness,
        requestId: getRequestId(req),
      });
      res.json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

attestationsRouter.post(
  "/:id/decision",
  requireAuth,
  rateLimitFor("attestation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        action?: "partial-slash" | "full-slash" | "dismiss";
      };
      await requireAttestationOwnership(
        req.params.id as string,
        auth.operatorId,
      );
      const outcome = await issueDecisionService({
        attestationId: req.params.id as string,
        operatorId: auth.operatorId,
        action: body.action,
        requestId: getRequestId(req),
      });
      res.status(201).json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

attestationsRouter.post(
  "/:id/enforce",
  requireAuth,
  rateLimitFor("attestation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        amountMinorUnits?: string;
        idempotencyKey?: string;
      };
      if (!body.idempotencyKey) {
        throw new ApiError("INVALID_IDENTIFIER", "idempotencyKey required");
      }
      await requireAttestationOwnership(
        req.params.id as string,
        auth.operatorId,
      );
      const { attestation, flag } = await buildDecisionFromAttestation(
        req.params.id as string,
      );
      if (attestation.agentId !== flag.agentId) {
        throw new ApiError("INVALID_ATTESTATION", "Subject mismatch");
      }
      const liveBond = await findLiveBondByAgent(attestation.agentId as string);
      if (!liveBond || liveBond.operator_id !== auth.operatorId) {
        throw new ApiError("FORBIDDEN", "No live bond for this agent");
      }
      if (!attestation.decision) {
        throw new ApiError("INVALID_ATTESTATION", "No decision to enforce");
      }
      const outcome = await runIdempotent({
        key: body.idempotencyKey,
        operatorId: auth.operatorId,
        route: "POST /api/v1/attestations/:id/enforce",
        fingerprint: fingerprintRequest(
          "POST /api/v1/attestations/:id/enforce",
          { id: req.params.id, amount: body.amountMinorUnits },
        ),
        execute: async () => {
          const { row } = await createTransactionIntent({
            operatorId: auth.operatorId,
            purpose: "ENFORCEMENT",
            agentId: attestation.agentId as string,
            bondId: liveBond.id,
            idempotencyKey: body.idempotencyKey as string,
            nullifier: attestation.decision?.nullifier as string | undefined,
            params: {
              attestationId: attestation.attestationId as string,
              decisionId: attestation.decision?.decisionId as string,
              flagId: flag.riskFlagId as string,
              amountMinorUnits: body.amountMinorUnits,
              slashEventId: undefined,
            },
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
