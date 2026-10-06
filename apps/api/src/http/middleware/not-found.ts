/**
 * Centralized JSON 404: unknown routes never return Express's default
 * HTML page. Uses the API envelope/error conventions with request ids.
 */
import type { Request, Response } from "express";

export function notFoundHandler(req: Request, res: Response): void {
  const requestId =
    typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : null;
  res.status(404).json({
    code: "NOT_FOUND",
    message: `No route for ${req.method} ${req.path}`,
    requestId,
  });
}
