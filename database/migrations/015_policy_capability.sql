-- 015: agent policy engine persistence (Phase 22, OFF-CHAIN only).
--
-- agent_policies: versioned operational policies, one ACTIVE per
-- agent. Versions are immutable once superseded (no UPDATE/DELETE
-- endpoints; PATCH creates a new version). UNIQUE (agent_id,
-- version) serializes concurrent creators: losers get a version
-- conflict, never a fork.
--
-- Conventions: lists are JSONB (null = unconstrained; present —
-- even empty — is enforced as given). Token/request/window counts
-- are BIGINT (non-negative). Money stays TEXT digit strings,
-- consistent with bonds/commitments (002). No secrets, ever.
--
-- Ledger usage columns (nullable, server-written from normalized
-- activity): provider/model attribution plus token and cost usage
-- for cumulative policy windows. Never textSnippet/metadata.
CREATE TABLE IF NOT EXISTS agent_policies (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  allowed_actions JSONB,
  denied_actions JSONB NOT NULL DEFAULT '[]',
  allowed_tools JSONB,
  denied_tools JSONB NOT NULL DEFAULT '[]',
  allowed_providers JSONB,
  denied_providers JSONB NOT NULL DEFAULT '[]',
  allowed_models JSONB,
  denied_models JSONB NOT NULL DEFAULT '[]',
  max_input_tokens BIGINT,
  max_output_tokens BIGINT,
  max_total_tokens BIGINT,
  max_total_tokens_per_window BIGINT,
  token_window_seconds BIGINT,
  max_requests_per_window BIGINT,
  request_window_seconds BIGINT,
  max_cost_minor_units_per_request TEXT,
  max_cost_minor_units_per_window TEXT,
  cost_window_seconds BIGINT,
  max_transfer_minor_units TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
CREATE INDEX IF NOT EXISTS agent_policies_agent_status_idx
  ON agent_policies(agent_id, status);

ALTER TABLE agent_activity_ledger
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS input_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS output_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS cost_minor_units TEXT;
