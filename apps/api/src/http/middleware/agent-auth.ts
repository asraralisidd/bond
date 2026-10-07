/**
 * Agent credential authentication (Phase 18, OFF-CHAIN only).
 *
 * Bearer secret format: `<credentialId>.<secret>` (mirrors session
 * tokens: the ID routes the lookup, the secret is hash-verified and
 * never stored). Flow: parse → hash → find credential → check status
 * and expiry → load agent → derive owner → build AgentPrincipal.
 *
 * Every failure returns a generic 401 that reveals nothing about
 * existence, revocation, ownership, or expiry. An agent credential
 * NEVER authenticates as an operator: operator-only routes keep using
 * requireAuth (session lookup misses credential secrets), and
 * requireOperator rejects agent principals with 403.
 */
import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors.js";
import {
  findAgentCredentialById,
  hashCredentialSecret,
  secretsEqual,
  touchAgentCredential,
} from "../../db/stores/agent-credentials.js";
import { findAgentById } from "../../db/stores/registry.js";
import { agentPrincipal } from "../principals.js";
import {
  findSessionByTokenHash,
  hashToken,
} from "../../db/stores/operators.js";
import { recordEvent } from "../../services/events.js";
import { getRequestId } from "../request-id.js";
import type { AuthContext } from "../auth.js";

export interface AgentAuth {
  readonly agentId: string;
  readonly credentialId: string;
  readonly capabilities: readonly string[];
}

function unauthorized(): ApiError {
  return new ApiError("UNAUTHORIZED", "Invalid or expired credential");
}

function parseCredential(
  bearer: string,
): { credentialId: string; secret: string } | null {
  if (!bearer.startsWith("cred_")) {
    return null;
  }
  const dot = bearer.indexOf(".");
  if (dot <= 5 || dot >= bearer.length - 1 || bearer.length > 256) {
    return null;
  }
  return {
    credentialId: bearer.slice(0, dot),
    secret: bearer.slice(dot + 1),
  };
}

/**
 * Dual authentication for agent-allowlisted routes: operator sessions
 * resolve exactly as in requireAuth; `cred_*` bearers resolve to an
 * agent principal. Anything else is a generic 401.
 */
export async function requireAgentOrOperator(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match?.[1]) {
      throw new ApiError("UNAUTHORIZED", "Missing bearer token");
    }
    const bearer = match[1];
    if (bearer.startsWith("sess_")) {
      // Operator path: identical semantics to requireAuth.
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
    const parsed = parseCredential(bearer);
    if (!parsed) {
      throw unauthorized();
    }
    // Audit target only — the credential id is the public half (like a
    // username), never the secret. Emitted on failure below.
    const attemptedId = parsed.credentialId;
    const fail = async (): Promise<never> => {
      try {
        await recordEvent({
          type: "agent.authentication_failed",
          agentId: null,
          actor: `credential:${attemptedId}`,
          requestId: getRequestId(req),
          payload: { credentialId: attemptedId },
        });
      } catch {
        // Audit must never break authentication.
      }
      throw unauthorized();
    };
    const found = await findAgentCredentialById(parsed.credentialId);
    const secretOk =
      found !== null &&
      found.status === "ACTIVE" &&
      secretsEqual(hashCredentialSecret(parsed.secret), found.secret_hash) &&
      (found.expires_at === null || Date.parse(found.expires_at) > Date.now());
    if (!secretOk) {
      await fail();
      throw unauthorized();
    }
    const credential = found as NonNullable<typeof found>;
    const agent = await findAgentById(credential.agent_id);
    if (!agent) {
      await fail();
      throw unauthorized();
    }
    const capabilities = Array.isArray(credential.capabilities)
      ? (credential.capabilities as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [];
    const principal = agentPrincipal({
      agentId: agent.id,
      operatorId: agent.operator_id,
      credentialId: credential.credential_id,
      capabilities,
    });
    req.auth = {
      operatorId: principal.operatorId,
      sessionId: "",
      authMethod: "agent-credential",
      walletVerifyingKey: null,
      agent: {
        agentId: principal.id,
        credentialId: principal.credentialId,
        capabilities: principal.capabilities,
      },
    };
    try {
      await touchAgentCredential(credential.credential_id);
    } catch {
      // Liveness bookkeeping must never break authentication.
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Auth context getter for agent-allowlisted routes (both principals). */
export function requireAuthContext(req: Request): AuthContext {
  if (!req.auth) {
    throw new ApiError("UNAUTHORIZED", "Authentication required");
  }
  return req.auth;
}

/** Capability gate for agent principals; no-op for operators. */
export async function requireAgentCapability(
  req: Request,
  auth: AuthContext,
  capability: string,
): Promise<void> {
  if (!auth.agent) {
    return;
  }
  if (!auth.agent.capabilities.includes(capability)) {
    try {
      await recordEvent({
        type: "agent.capability_denied",
        agentId: auth.agent.agentId,
        actor: `agent:${auth.agent.agentId}`,
        requestId: getRequestId(req),
        payload: {
          capability,
          credentialId: auth.agent.credentialId,
        },
      });
    } catch {
      // Audit must never break authorization.
    }
    throw new ApiError("FORBIDDEN", "Capability not granted");
  }
}

/**
 * Self-agent guard: an agent principal may only address its own agent
 * id. Operators fall through to the existing ownership checks.
 */
export function requireSelfAgent(auth: AuthContext, agentId: string): void {
  if (!auth.agent) {
    return;
  }
  if (auth.agent.agentId !== agentId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
}
