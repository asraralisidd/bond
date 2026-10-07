/**
 * Event feed: cursor-paginated reads over append-only protocol_events.
 *
 * POLLABLE ONLY — no webhooks, SSE, or push of any kind.
 *
 * Scope is derived from the authenticated principal, never from input:
 * operators see events for agents they own; agents see only their own
 * agent's events (gated on the risk:read capability, which governs
 * own-findings reads elsewhere — reusing it creates no new bypass
 * because every event returned is already visible to these principals
 * through existing endpoints). Unauthenticated callers are rejected.
 *
 * Pagination is keyset on (created_at, id): deterministic, stable
 * under concurrent inserts, no OFFSET. Cursors are opaque base64url
 * blobs carrying a full-precision epoch + row id — no secrets, no
 * offsets, no database internals beyond what ordering requires.
 * Malformed cursors are a safe 400. Reads never emit events.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors.js";
import { rateLimitFor } from "../rate-limit/middleware.js";
import {
  requireAgentCapability,
  requireAgentOrOperator,
  requireAuthContext,
} from "../middleware/agent-auth.js";
import {
  listProtocolEventsPage,
  type EventPageRow,
} from "../../db/stores/events.js";

export const eventsRouter = Router();

interface FeedCursor {
  readonly createdEpoch: string;
  readonly id: string;
}

function encodeCursor(row: EventPageRow): string {
  return Buffer.from(
    JSON.stringify({ t: row.created_epoch, id: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: unknown): FeedCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { t, id } = parsed as { t?: unknown; id?: unknown };
  if (
    typeof t !== "string" ||
    typeof id !== "string" ||
    !/^\d+(\.\d+)?$/.test(t) ||
    t.length > 32 ||
    id.length === 0 ||
    id.length > 256
  ) {
    return null;
  }
  return { createdEpoch: t, id };
}

export interface EventFeedItem {
  readonly id: string;
  readonly type: string;
  readonly agentId: string | null;
  readonly bondId: string | null;
  readonly txId: string | null;
  readonly actor: string;
  readonly policyVersion: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
}

function toFeedItem(row: EventPageRow): EventFeedItem {
  return {
    id: row.id,
    type: row.type,
    agentId: row.agent_id,
    bondId: row.bond_id,
    txId: row.tx_id,
    actor: row.actor,
    policyVersion: row.policy_version,
    requestId: row.request_id,
    createdAt: row.created_at,
    // Payloads are privacy-scrubbed by every producer by convention
    // (store contract); every field here is already visible to these
    // principals through existing resource endpoints.
    payload: row.payload,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

eventsRouter.get(
  "/",
  requireAgentOrOperator,
  rateLimitFor("read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = requireAuthContext(req);
      const rawLimit = req.query.limit ?? DEFAULT_LIMIT;
      const limit =
        typeof rawLimit === "string" || typeof rawLimit === "number"
          ? Number(rawLimit)
          : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new ApiError("INVALID_IDENTIFIER", "Invalid limit");
      }
      let after: FeedCursor | null = null;
      if (req.query.cursor !== undefined) {
        const decoded = decodeCursor(req.query.cursor);
        if (decoded === null) {
          throw new ApiError("INVALID_IDENTIFIER", "Invalid cursor");
        }
        after = decoded;
      }
      const rawType = req.query.type;
      let type: string | null = null;
      if (rawType !== undefined) {
        if (
          typeof rawType !== "string" ||
          rawType.length === 0 ||
          rawType.length > 128
        ) {
          throw new ApiError("INVALID_IDENTIFIER", "Invalid type filter");
        }
        type = rawType;
      }
      let scope: { agentId?: string; operatorId?: string };
      if (auth.agent) {
        // Agents observe only their own history. risk:read governs
        // own-findings reads on /risk/flags*; reusing it here grants
        // no new data — every returned event is about this agent.
        await requireAgentCapability(req, auth, "risk:read");
        scope = { agentId: auth.agent.agentId };
      } else {
        scope = { operatorId: auth.operatorId };
      }
      const rows = await listProtocolEventsPage(scope, after, type, limit + 1);
      const page = rows.slice(0, limit);
      const nextCursor =
        rows.length > limit && page.length > 0
          ? encodeCursor(page[page.length - 1] as EventPageRow)
          : null;
      res.json({
        data: {
          events: page.map(toFeedItem),
          nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);
