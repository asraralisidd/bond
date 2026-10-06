/**
 * Attestor authentication at the Express middleware layer.
 *
 * Semantics unchanged (per-attestor secret verified against the stored
 * hash, active status required); previously this lived inside the
 * service. Moving it here makes authentication consistent: every
 * protected route now declares its auth in the route definition.
 */
import type { Request, Response, NextFunction } from "express";
import { checkAttestorSecret } from "../../services/attestations.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      attestorId?: string;
    }
  }
}

export async function requireAttestor(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as { attestorId?: string } | undefined;
    const attestorId =
      typeof body?.attestorId === "string" ? body.attestorId : "";
    const secret =
      typeof req.headers["x-attestor-secret"] === "string"
        ? (req.headers["x-attestor-secret"] as string)
        : undefined;
    await checkAttestorSecret(attestorId, secret);
    req.attestorId = attestorId;
    next();
  } catch (error) {
    next(error);
  }
}
