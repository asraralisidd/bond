/**
 * Public verification: unauthenticated, rate-limit friendly, and
 * restricted to the audited public projection functions. Answers
 * registration/eligibility/standing from confirmed records only —
 * "no confirmed violation" is never presented as "proven safe".
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  parseSlashEventId,
  verifyAgentPublic,
  toPublicReputationView,
  toPublicSlashRecord,
} from "@bond/shared-types";
import type {
  AgentStatus,
  BondStatus,
  ReputationStanding,
  RiskSeverity,
} from "@bond/shared-types";
import { ApiError } from "../errors.js";
import {
  findAgentById,
  findLiveBondByAgent,
} from "../../db/stores/registry.js";
import {
  latestReputationByAgent,
  listSlashEventsByAgent,
} from "../../db/stores/attestation.js";
import { query } from "../../db/pool.js";

export const publicRouter = Router();

async function buildVerification(agentId: string) {
  const agent = await findAgentById(agentId);
  if (!agent) {
    throw new ApiError("NOT_FOUND", "Agent not found");
  }
  const bond = await findLiveBondByAgent(agentId);
  const reputation = await latestReputationByAgent(agentId);
  const slashes = await listSlashEventsByAgent(agentId, 100);
  const openFlags: { rows: { count: string }[] } = await query(
    "SELECT COUNT(*) AS count FROM risk_flags WHERE agent_id = $1 AND status IN ('open', 'under-review')",
    [agentId],
  );
  const standing = (reputation?.standing ?? "good") as ReputationStanding;
  const completedSlashes = slashes.filter(
    (s) => s.status === "completed",
  ).length;
  const verdict = verifyAgentPublic({
    agentId,
    registrationStatus: agent.status as AgentStatus,
    bondStatus: (bond?.status ?? "CREATED") as BondStatus,
    reputationStanding: standing,
    completedSlashCount: completedSlashes,
    openFlagCount: Number(openFlags.rows[0]?.count ?? 0),
    asOf: new Date().toISOString(),
    policyVersion: agent.policy_version,
  });
  return {
    verification: verdict,
    bond: bond ? { status: bond.status } : null,
    reputation: reputation
      ? toPublicReputationView({
          standing,
          factors: {
            confirmedFlags: 0,
            partialSlashes: slashes.filter((s) => !s.is_full_slash).length,
            fullSlashes: slashes.filter((s) => s.is_full_slash).length,
            cleanBondsCompleted: 0,
            remediatedResolutions: 0,
          },
        })
      : null,
    slashHistory: slashes.map((s) =>
      toPublicSlashRecord({
        slashEventId: parseSlashEventId(s.id),
        isFullSlash: s.is_full_slash,
        severity: (["low", "medium", "high", "critical"].includes(s.severity)
          ? s.severity
          : "medium") as RiskSeverity,
        completedAt: null,
      }),
    ),
  };
}

publicRouter.get(
  "/agents/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await buildVerification(req.params.id as string) });
    } catch (error) {
      next(error);
    }
  },
);

publicRouter.get(
  "/agents/:id/eligibility",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id as string;
      const agent = await findAgentById(agentId);
      if (!agent) {
        throw new ApiError("NOT_FOUND", "Agent not found");
      }
      const policyVersion =
        (req.query.policyVersion as string | undefined) ?? agent.policy_version;
      const proofs: {
        rows: { id: string; purpose: string; status: string }[];
      } = await query(
        `SELECT id, purpose, status FROM eligibility_proofs
           WHERE agent_id = $1 AND policy_version = $2
             AND status NOT IN ('EXPIRED')
           ORDER BY created_at DESC LIMIT 5`,
        [agentId, policyVersion],
      );
      res.json({
        data: {
          agentId,
          policyVersion,
          eligible: proofs.rows.some(
            (p) => p.status === "VERIFIED" || p.status === "CREATED",
          ),
          proofs: proofs.rows.map((p) => ({
            proofId: p.id,
            purpose: p.purpose,
            status: p.status,
          })),
          asOf: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);
