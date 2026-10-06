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
  if (config.devAuthToken === null || provided !== config.devAuthToken) {
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
    req.auth = { operatorId: session.operator_id, sessionId: session.id };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireOperator(req: Request): AuthContext {
  if (!req.auth) {
    throw new ApiError("UNAUTHORIZED", "Authentication required");
  }
  return req.auth;
}

/** Ownership guard: rows carry operator_id; cross-operator access is 403. */
export function requireOwner(rowOperatorId: string, auth: AuthContext): void {
  if (rowOperatorId !== auth.operatorId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
}
