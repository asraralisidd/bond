/**
 * Risk routes: activity analysis (owner) + flag reads (owner).
 * Flag detail excludes raw evidence content by construction —
 * only descriptors (hashes/pointers) are stored and returned.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { RawActivityInput } from "@bond/risk-engine";
import { requireAuth, requireOperator } from "../auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { getRequestId } from "../request-id.js";
import { ApiError } from "../errors.js";
import {
  findRiskFlagById,
  listRiskFlagsByAgent,
} from "../../db/stores/risk.js";
import { getAgentService } from "../../services/agents.js";
import { analyzeActivityService, toScoreDto } from "../../services/risk.js";

export const riskRouter = Router();

riskRouter.post(
  "/analyses",
  requireAuth,
  rateLimitFor("expensive"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as {
        agentId?: string;
        activity?: Omit<RawActivityInput, "agentId">;
      };
      if (!body.agentId || !body.activity) {
        throw new ApiError(
          "INVALID_IDENTIFIER",
          "agentId and activity required",
        );
      }
      const outcome = await analyzeActivityService({
        operatorId: auth.operatorId,
        agentId: body.agentId,
        activity: body.activity,
        requestId: getRequestId(req),
      });
      res.status(201).json({
        data: {
          analysisId: outcome.analysisId,
          flagIds: outcome.flagIds,
          score: toScoreDto(outcome.score),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

riskRouter.get(
  "/flags",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const agentId = req.query.agentId as string | undefined;
      if (!agentId) {
        throw new ApiError("INVALID_IDENTIFIER", "agentId query required");
      }
      await getAgentService(agentId, auth.operatorId);
      const rows = await listRiskFlagsByAgent(agentId, 100);
      res.json({
        data: rows.map((r) => ({
          riskFlagId: r.id,
          category: r.category,
          severity: r.severity,
          confidence: r.confidence,
          evidenceIds: r.evidence_ids,
          modelVersion: r.model_version,
          status: r.status,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

riskRouter.get(
  "/flags/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const row = await findRiskFlagById(req.params.id as string);
      if (!row) {
        throw new ApiError("NOT_FOUND", "Risk flag not found");
      }
      await getAgentService(row.agent_id, auth.operatorId);
      res.json({
        data: {
          riskFlagId: row.id,
          category: row.category,
          severity: row.severity,
          confidence: row.confidence,
          evidenceIds: row.evidence_ids,
          modelVersion: row.model_version,
          status: row.status,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);
