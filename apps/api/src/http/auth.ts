/**
 * Development-only operator authentication.
 *
 * INTERIM MODEL (explicitly not production auth): bearer tokens issued
 * by POST /auth/session when the request carries a pre-shared dev key
 * (DEV_AUTH_TOKEN env). Wallet-signature login is BLOCKED pending the
 * Phase 5 Lace/session shape; operators.wallet_address is reserved for it.
 *
 * Sessions store token hashes only. Expired/revoked sessions are rejected.
 */
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config.js";
import { ApiError } from "./errors.js";
import {
  createOperator,
  createSession,
  findSessionByTokenHash,
  hashToken,
  newToken,
} from "../db/stores/operators.js";

export interface AuthContext {
  readonly operatorId: string;
  readonly sessionId: string;
  readonly authMethod: string;
  readonly walletVerifyingKey: string | null;
  /**
   * Present only when authenticated via an agent credential (Phase 18).
   * Operator sessions never carry this field.
   */
  readonly agent?: {
    readonly agentId: string;
    readonly credentialId: string;
    readonly capabilities: readonly string[];
  };
  /**
   * Present only when authorized via a consumed setup grant (Phase 19).
   * A grant is single-use setup authority, never a session — operator
   * sessions and agent credentials never carry this field.
   */
  readonly grant?: {
    readonly grantId: string;
    readonly scopes: readonly string[];
    readonly agentId: string | null;
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string | null;
    }
  }
}

export async function issueDevSession(
  externalKey: string,
): Promise<{ token: string; operatorId: string; sessionId: string }> {
  const config = loadConfig();
  if (config.devAuthToken === null) {
    throw new ApiError(
      "UNAUTHORIZED",
      "Development authentication is not enabled",
    );
  }
  const operatorId = `op_${externalKey}`;
  await createOperator(operatorId, externalKey);
  const { id, token } = newToken("sess");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await createSession(id, operatorId, hashToken(token), expiresAt);
  return { token, operatorId, sessionId: id };
}

export function checkDevKey(provided: string | undefined): void {
  const config = loadConfig();
  // Constant-time comparison: dev keys are short, but brute-force
  // resistance must not depend on early-exit timing cliffs.
  const expected = config.devAuthToken ?? "";
  const a = Buffer.from(provided ?? "");
  const b = Buffer.from(expected);
  const match = a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
  if (config.devAuthToken === null || !match) {
    throw new ApiError("UNAUTHORIZED", "Invalid development credentials");
  }
}

export async function requireAuth(
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
    const session = await findSessionByTokenHash(hashToken(match[1]));
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
  } catch (error) {
    next(error);
  }
}

export function requireOperator(req: Request): AuthContext {
  if (!req.auth) {
    throw new ApiError("UNAUTHORIZED", "Authentication required");
  }
  if (req.auth.agent) {
    // Agent credentials are never operator credentials, even though
    // they resolve to the owning operator for scoping reads.
    throw new ApiError(
      "FORBIDDEN",
      "Agent credentials cannot access operator routes",
    );
  }
  if (req.auth.grant) {
    // Setup grants authorize one setup operation only — never general
    // operator access, even though they resolve to the issuing operator.
    throw new ApiError(
      "FORBIDDEN",
      "Setup grants cannot access operator routes",
    );
  }
  return req.auth;
}

/** Ownership guard: rows carry operator_id; cross-operator access is 403. */
export function requireOwner(rowOperatorId: string, auth: AuthContext): void {
  if (rowOperatorId !== auth.operatorId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
}
