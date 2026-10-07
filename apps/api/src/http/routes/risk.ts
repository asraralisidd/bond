/**
 * Risk routes: activity analysis (owner) + flag reads (owner).
 * Flag detail excludes raw evidence content by construction —
 * only descriptors (hashes/pointers) are stored and returned.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { RawActivityInput } from "@bond/risk-engine";
import { parseRiskFlagId } from "@bond/shared-types";
import {
  requireAgentCapability,
  requireAgentOrOperator,
  requireAuthContext,
  requireSelfAgent,
} from "../middleware/agent-auth.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import { getRequestId } from "../request-id.js";
import { ApiError } from "../errors.js";
import {
  findRiskFlagById,
  listRiskFlagsByAgent,
} from "../../db/stores/risk.js";
import { getAgentService } from "../../services/agents.js";
import { authorizeDelegatedUse } from "../../services/delegations.js";
import { analyzeActivityService, toScoreDto } from "../../services/risk.js";

export const riskRouter = Router();

riskRouter.post(
  "/analyses",
  requireAgentOrOperator,
  rateLimitFor("expensive"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      const body = req.body as {
        agentId?: string;
        activity?: Omit<RawActivityInput, "agentId">;
        delegationId?: string;
      };
      if (!body.agentId || !body.activity) {
        throw new ApiError(
          "INVALID_IDENTIFIER",
          "agentId and activity required",
        );
      }
      // Delegated submission: capability and scope are authorized
      // inside the service against the live delegation record; the
      // executor binding below still holds (agentId = caller).
      // Operator sessions never invoke delegations (direct access).
      const useDelegation =
        body.delegationId !== undefined &&
        body.delegationId !== null &&
        auth.agent !== undefined;
      if (!useDelegation) {
        if (
          body.delegationId !== undefined &&
          body.delegationId !== null &&
          typeof body.delegationId !== "string"
        ) {
          throw new ApiError("INVALID_IDENTIFIER", "Invalid delegationId");
        }
        await requireAgentCapability(req, auth, "activity:submit");
      }
      requireSelfAgent(auth, body.agentId);
      const outcome = await analyzeActivityService({
        operatorId: auth.operatorId,
        agentId: body.agentId,
        activity: body.activity,
        delegationId: useDelegation ? (body.delegationId as string) : null,
        requestId: getRequestId(req),
      });
      res.status(201).json({
        data: {
          analysisId: outcome.analysisId,
          flagIds: outcome.flagIds,
          score: toScoreDto(outcome.score),
          policy: outcome.policy,
          attribution: outcome.attribution,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

riskRouter.get(
  "/flags",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      const agentId = req.query.agentId as string | undefined;
      if (!agentId) {
        throw new ApiError("INVALID_IDENTIFIER", "agentId query required");
      }
      const delegationId = req.query.delegationId as string | undefined;
      if (delegationId === undefined || auth.agent === undefined) {
        await requireAgentCapability(req, auth, "risk:read");
        requireSelfAgent(auth, agentId);
      } else {
        // Delegated read: the requested agent must be the delegator;
        // the caller is the delegate acting on its behalf.
        const granted = await authorizeDelegatedUse({
          delegateAgentId: auth.agent.agentId,
          delegationId,
          requiredCapability: "risk:read",
          operation: null,
          requestId: getRequestId(req),
        });
        if (granted.delegatorAgentId !== agentId) {
          throw new ApiError("DELEGATION_DENIED", "Delegation not authorized");
        }
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
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      parseRiskFlagId(req.params.id);
      const row = await findRiskFlagById(req.params.id as string);
      if (!row) {
        throw new ApiError("NOT_FOUND", "Risk flag not found");
      }
      const delegationId = req.query.delegationId as string | undefined;
      if (delegationId === undefined || auth.agent === undefined) {
        await requireAgentCapability(req, auth, "risk:read");
        requireSelfAgent(auth, row.agent_id);
      } else {
        const granted = await authorizeDelegatedUse({
          delegateAgentId: auth.agent.agentId,
          delegationId,
          requiredCapability: "risk:read",
          operation: null,
          requestId: getRequestId(req),
        });
        if (granted.delegatorAgentId !== row.agent_id) {
          throw new ApiError("DELEGATION_DENIED", "Delegation not authorized");
        }
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
