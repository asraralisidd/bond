/**
 * Agent registry routes (owner-scoped; public reads live under /public).
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AgentStatus } from "@bond/shared-types";
import { toAgentPrivateView } from "../dto.js";
import { requireAuth, requireOperator } from "../auth.js";
import {
  requireOperatorOrGrant,
  requireOperatorOrGrantContext,
} from "../middleware/grant-auth.js";
import {
  requireAgentCapability,
  requireAgentOrOperator,
  requireAuthContext,
  requireSelfAgent,
} from "../middleware/agent-auth.js";
import { ApiError } from "../errors.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import {
  getAgentService,
  listAgentsService,
  registerAgentService,
  transitionAgentService,
} from "../../services/agents.js";
import {
  REPUTATION_BASELINE_SCORE,
  REPUTATION_VERSION,
  trustLevelForScore,
} from "@bond/shared-types";
import {
  getAgentReputation,
  listReputationEvents,
} from "../../db/stores/reputation.js";
import {
  fingerprintRequest,
  runIdempotent,
} from "../../services/idempotency.js";
import {
  createPolicyService,
  getPolicyService,
  listPolicyHistoryService,
  updatePolicyService,
} from "../../services/policies.js";
import {
  createDelegationService,
  listDelegationsService,
} from "../../services/delegations.js";
import { getRequestId } from "../request-id.js";

export const agentsRouter = Router();

agentsRouter.post(
  "/",
  requireOperatorOrGrant("agent:register"),
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperatorOrGrantContext(req);
      const body = req.body as {
        platform?: string;
        agentType?: string;
        capabilities?: string[];
        externalRef?: string;
      };
      const outcome = await runIdempotent({
        key: req.headers["idempotency-key"] as string | undefined,
        operatorId: auth.operatorId,
        route: "POST /api/v1/agents",
        fingerprint: fingerprintRequest("POST /api/v1/agents", body),
        execute: async () => {
          const row = await registerAgentService({
            operatorId: auth.operatorId,
            platform: body.platform ?? "",
            agentType: body.agentType ?? "",
            capabilities: body.capabilities ?? [],
            externalRef: body.externalRef ?? "",
            requestId: getRequestId(req),
            actor: `operator:${auth.operatorId}`,
          });
          return toAgentPrivateView(row);
        },
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const rawLimit = req.query.limit ?? 50;
      const limit =
        typeof rawLimit === "string" || typeof rawLimit === "number"
          ? Number(rawLimit)
          : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ApiError("INVALID_IDENTIFIER", "Invalid limit");
      }
      const rows = await listAgentsService(auth.operatorId, limit);
      res.json({ data: rows.map(toAgentPrivateView) });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/:id",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      await requireAgentCapability(req, auth, "agent:read");
      requireSelfAgent(auth, req.params.id as string);
      const row = await getAgentService(
        req.params.id as string,
        auth.operatorId,
      );
      res.json({ data: toAgentPrivateView(row) });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Agent reputation (Phase 21, advisory trust intelligence).
 * Operators read owned agents; agent credentials with
 * `reputation:read` read only their own agent. New agents without
 * history report the documented baseline (no row is written by
 * reads). History is bounded (limit, newest first, no offsets).
 */
agentsRouter.get(
  "/:id/reputation",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      await requireAgentCapability(req, auth, "reputation:read");
      requireSelfAgent(auth, req.params.id as string);
      const agentId = req.params.id as string;
      await getAgentService(agentId, auth.operatorId);
      const rawLimit = req.query.limit;
      let limit = 20;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ApiError("INVALID_IDENTIFIER", "Invalid limit");
        }
      }
      const state = await getAgentReputation(agentId);
      const events = await listReputationEvents(agentId, limit);
      const score = state === null ? REPUTATION_BASELINE_SCORE : state.score;
      const trustLevel =
        state === null ? trustLevelForScore(score) : state.trust_level;
      res.json({
        data: {
          agentId,
          score,
          trustLevel,
          version: state === null ? REPUTATION_VERSION : state.version,
          updatedAt: state?.updated_at ?? null,
          events: events.map((e) => ({
            eventId: e.id,
            eventType: e.event_type,
            sourceType: e.source_type,
            sourceId: e.source_id,
            impact: e.impact,
            scoreBefore: e.score_before,
            scoreAfter: e.score_after,
            reasonCode: e.reason_code,
            reason: e.reason,
            version: e.reputation_version,
            createdAt: e.created_at,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.patch(
  "/:id/status",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { status?: AgentStatus };
      const row = await transitionAgentService(
        req.params.id as string,
        auth.operatorId,
        body.status as AgentStatus,
        getRequestId(req),
      );
      res.json({ data: toAgentPrivateView(row) });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Agent policy management (Phase 22, operator-controlled).
 * Mutations are operator-only (setup-grant bearers fail at
 * requireOperator); agents with `agent:read` may read their own
 * effective policy but can never mutate it. Versions are immutable:
 * PATCH amends by creating the next version behind an
 * expectedVersion gate (stale writes get 409, never silent loss).
 */
agentsRouter.post(
  "/:id/policy",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { policy?: unknown };
      const outcome = await runIdempotent({
        key: req.headers["idempotency-key"] as string | undefined,
        operatorId: auth.operatorId,
        route: "POST /api/v1/agents/:id/policy",
        fingerprint: fingerprintRequest("POST /api/v1/agents/:id/policy", body),
        execute: async () =>
          createPolicyService({
            operatorId: auth.operatorId,
            agentId: req.params.id as string,
            policy: (body.policy ?? {}) as never,
            requestId: getRequestId(req),
          }),
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/:id/policy",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      await requireAgentCapability(req, auth, "agent:read");
      requireSelfAgent(auth, req.params.id as string);
      const view = await getPolicyService({
        operatorId: auth.operatorId,
        agentId: req.params.id as string,
      });
      if (!view) {
        throw new ApiError("NOT_FOUND", "No active policy for agent");
      }
      res.json({ data: view });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.patch(
  "/:id/policy",
  requireAuth,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireOperator(req);
      const body = req.body as { expectedVersion?: unknown; policy?: unknown };
      const outcome = await updatePolicyService({
        operatorId: auth.operatorId,
        agentId: req.params.id as string,
        expectedVersion: body.expectedVersion as number,
        patch: (body.policy ?? {}) as never,
        requestId: getRequestId(req),
      });
      res.json({ data: outcome });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/:id/policy/history",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      await requireAgentCapability(req, auth, "agent:read");
      requireSelfAgent(auth, req.params.id as string);
      const rawLimit = req.query.limit;
      let limit = 20;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ApiError("INVALID_IDENTIFIER", "Invalid limit");
        }
      }
      const views = await listPolicyHistoryService({
        operatorId: auth.operatorId,
        agentId: req.params.id as string,
        limit,
      });
      res.json({ data: views });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Agent delegation management (Phase 23).
 * Creation: operators owning the delegator, or the delegator agent
 * itself (possession of each delegated capability is verified
 * server-side against live credentials). Listing: operators owning
 * the agent, or the agent itself for its own delegations.
 */
agentsRouter.post(
  "/:id/delegations",
  requireAgentOrOperator,
  rateLimitFor("mutation"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      const body = req.body as {
        delegateAgentId?: string;
        capabilities?: unknown;
        expiresAt?: unknown;
        scope?: unknown;
      };
      const agentId = req.params.id as string;
      if (auth.agent !== undefined && auth.agent.agentId !== agentId) {
        throw new ApiError("FORBIDDEN", "Not your delegation");
      }
      if (typeof body.delegateAgentId !== "string") {
        throw new ApiError("INVALID_IDENTIFIER", "delegateAgentId required");
      }
      const outcome = await runIdempotent({
        key: req.headers["idempotency-key"] as string | undefined,
        operatorId: auth.operatorId,
        route: "POST /api/v1/agents/:id/delegations",
        fingerprint: fingerprintRequest("POST /api/v1/agents/:id/delegations", {
          ...body,
          delegator: agentId,
        }),
        execute: async () =>
          createDelegationService({
            operatorId: auth.operatorId,
            creatorAgentId: auth.agent?.agentId,
            delegatorAgentId: agentId,
            delegateAgentId: body.delegateAgentId as string,
            capabilities: body.capabilities,
            expiresAt: body.expiresAt,
            scope: body.scope,
            requestId: getRequestId(req),
          }),
      });
      res.status(outcome.replayed ? 200 : 201).json({ data: outcome.body });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.get(
  "/:id/delegations",
  requireAgentOrOperator,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      const agentId = req.params.id as string;
      if (auth.agent !== undefined && auth.agent.agentId !== agentId) {
        throw new ApiError("FORBIDDEN", "Not your delegations");
      }
      const rawRole = req.query.role;
      const role =
        rawRole === undefined || rawRole === "all"
          ? "all"
          : rawRole === "delegator" || rawRole === "delegate"
            ? rawRole
            : null;
      if (role === null) {
        throw new ApiError("INVALID_IDENTIFIER", "Invalid role");
      }
      const rawLive = req.query.live;
      const liveOnly = rawLive !== "false";
      const rawLimit = req.query.limit;
      let limit = 20;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ApiError("INVALID_IDENTIFIER", "Invalid limit");
        }
      }
      const views = await listDelegationsService({
        operatorId: auth.operatorId,
        creatorAgentId: auth.agent?.agentId,
        agentId,
        role,
        liveOnly,
        limit,
      });
      res.json({ data: views });
    } catch (error) {
      next(error);
    }
  },
);
