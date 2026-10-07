-- 013: agent activity ledger (Phase 20, OFF-CHAIN only).
--
-- One row per analyzed activity, written server-side in the same
-- transaction as the risk analysis. Powers bounded behavioral windows
-- (counts, spend velocity, tool baseline, repeat violations).
--
-- Privacy: action/tool/amount only — NEVER textSnippet, metadata,
-- secrets, or raw content. Same PRIVATE convention as
-- bonds.commitment_minor_units (002). Owner + own-agent visible only.
--
-- occurred_at is the client-supplied claim (display only). created_at
-- is the server timestamp and the ONLY authority for behavioral
-- windows — backdated occurred_at cannot move a row into/out of a
-- window. Rows are insert-only: no UPDATE/DELETE endpoint exists;
-- retention is a bounded opportunistic purge (see ledger-cleanup).
CREATE TABLE IF NOT EXISTS agent_activity_ledger (
  analysis_id TEXT PRIMARY KEY REFERENCES risk_analyses(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_type TEXT NOT NULL,
  action TEXT NOT NULL,
  tool TEXT,
  amount_minor_units TEXT,
  bytes_out BIGINT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_ledger_agent_time_idx
  ON agent_activity_ledger(agent_id, created_at DESC);
