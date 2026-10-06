/**
 * Request correlation: ingress x-request-id (generated when absent),
 * echoed on every response, attached to logs and protocol events.
 */
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers["x-request-id"];
  const requestId =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : `req_${randomBytes(12).toString("hex")}`;
  req.headers["x-request-id"] = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

export function getRequestId(req: Request): string | null {
  const value = req.headers["x-request-id"];
  return typeof value === "string" ? value : null;
}
