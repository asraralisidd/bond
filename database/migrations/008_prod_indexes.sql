-- 008: production query-path indexes (forward-only addition).
-- protocol_events(created_at): time-ordered audit reads and retention scans.
-- risk_flags(agent_id, status): open-flag counts per agent (public verification).
-- idempotency_keys(expires_at): TTL reclaim scans without full table scan.
CREATE INDEX IF NOT EXISTS protocol_events_created_idx
  ON protocol_events(created_at);
CREATE INDEX IF NOT EXISTS risk_flags_agent_status_idx
  ON risk_flags(agent_id, status);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx
  ON idempotency_keys(expires_at);
