/**
 * Setup-grant authorization (Phase 19, OFF-CHAIN only).
 *
 * Dual authentication for grant-allowlisted setup routes: operator
 * sessions resolve exactly as in requireAuth; `grant_*` bearers are
 * verified and ATOMICALLY CONSUMED (single conditional UPDATE — exactly
 * one concurrent consumer wins) and must carry the route's scope.
 * Anything else is a generic 401 that reveals nothing about existence,
 * revocation, or expiry.
 *
 * Consume-first ordering is deliberate: the grant is spent even when a
 * later check (scope, agent binding) fails. Burns are fail-closed and
 * documented; the alternative (pre-read then consume) reintroduces the
 * TOCTOU window atomic consumption exists to close.
 *
 * A consumed grant NEVER becomes a session, credential, or operator
 * principal: req.auth carries a grant marker that requireOperator
 * rejects, and no code path mints further authority from it.
 */
import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors.js";
import {
  findSessionByTokenHash,
  hashToken,
} from "../../db/stores/operators.js";
import {
  consumeSetupGrantService,
  requireGrantAgent,
} from "../../services/setup-grants.js";
import type { SetupGrantScope } from "../../services/setup-grants.js";
import { getRequestId } from "../request-id.js";
import type { AuthContext } from "../auth.js";

export function requireAuthContext(req: Request): AuthContext {
  if (!req.auth) {
    throw new ApiError("UNAUTHORIZED", "Authentication required");
  }
  return req.auth;
}

/**
 * Context getter for grant-allowlisted setup routes. Operator sessions
 * pass through; grant principals pass with their bound operator;
 * agent credentials are rejected (they have their own routes).
 */
export function requireOperatorOrGrantContext(req: Request): AuthContext {
  const auth = requireAuthContext(req);
  if (auth.agent) {
    throw new ApiError(
      "FORBIDDEN",
      "Agent credentials cannot access setup routes",
    );
  }
  return auth;
}

/**
 * Enforces a grant's agent binding against the operation's target
 * agent. No-op for operator sessions and unbound grants.
 */
export function requireGrantAgentMatch(
  auth: AuthContext,
  agentId: string | null | undefined,
): void {
  if (!auth.grant || auth.grant.agentId === null) {
    return;
  }
  if (agentId !== auth.grant.agentId) {
    throw new ApiError("FORBIDDEN", "Grant agent binding mismatch");
  }
}

function parseGrant(
  bearer: string,
): { grantId: string; secret: string } | null {
  if (!bearer.startsWith("grant_")) {
    return null;
  }
  const dot = bearer.indexOf(".");
  if (dot <= 6 || dot >= bearer.length - 1 || bearer.length > 256) {
    return null;
  }
  return {
    grantId: bearer.slice(0, dot),
    secret: bearer.slice(dot + 1),
  };
}

/**
 * Operator sessions pass through unchanged; grant bearers must carry
 * `requiredScope` and are consumed exactly once.
 */
export function requireOperatorOrGrant(requiredScope: SetupGrantScope) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const header = req.headers.authorization ?? "";
      const match = /^Bearer (.+)$/.exec(header);
      if (!match?.[1]) {
        throw new ApiError("UNAUTHORIZED", "Missing bearer token");
      }
      const bearer = match[1];
      if (bearer.startsWith("sess_")) {
        const session = await findSessionByTokenHash(hashToken(bearer));
        if (
          !session ||
          session.revoked ||
          Date.parse(session.expires_at) <= Date.now()
        ) {
          throw new ApiError("UNAUTHORIZED", "Invalid or expired session");
        }
        req.auth = {
          operatorId: session.operator_id,
          sessionId: session.id,
          authMethod: session.auth_method,
          walletVerifyingKey: session.wallet_verifying_key,
        };
        next();
        return;
      }
      const parsed = parseGrant(bearer);
      if (!parsed) {
        throw new ApiError("UNAUTHORIZED", "Invalid or expired grant");
      }
      const consumed = await consumeSetupGrantService({
        grantId: parsed.grantId,
        secret: parsed.secret,
        requestId: getRequestId(req),
      });
      if (!consumed.scopes.includes(requiredScope)) {
        throw new ApiError("FORBIDDEN", "Grant scope not authorized");
      }
      if (consumed.agentId !== null) {
        await requireGrantAgent(consumed);
      }
      req.auth = {
        operatorId: consumed.operatorId,
        sessionId: "",
        authMethod: "setup-grant",
        walletVerifyingKey: null,
        grant: {
          grantId: consumed.grantId,
          scopes: consumed.scopes,
          agentId: consumed.agentId,
        },
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}
