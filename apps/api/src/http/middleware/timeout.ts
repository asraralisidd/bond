/**
 * Bounded HTTP request timeout.
 *
 * Boundary: this ends the HTTP response only. Domain work, background
 * transaction processing, and chain state are untouched — a timed-out
 * request never marks a transaction FAILED or CONFIRMED, and no
 * AbortController reaches domain/chain operations.
 */
import type { Request, Response, NextFunction } from "express";

export const REQUEST_TIMEOUT_CODE = "REQUEST_TIMEOUT";

export function timeoutMiddleware(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (timeoutMs <= 0) {
      next();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || res.headersSent) {
        return;
      }
      settled = true;
      const requestId =
        typeof req.headers["x-request-id"] === "string"
          ? req.headers["x-request-id"]
          : null;
      res.status(503).json({
        code: REQUEST_TIMEOUT_CODE,
        message: "Request timed out",
        requestId,
      });
    }, timeoutMs);
    // timer.unref() so idle servers can still exit cleanly.
    timer.unref?.();
    const done = () => {
      settled = true;
      clearTimeout(timer);
    };
    res.on("finish", done);
    res.on("close", done);
    next();
  };
}
