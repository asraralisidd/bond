-- 014: event-sourced reputation trust layer (Phase 21, OFF-CHAIN only).
--
-- Complements (does NOT replace) the v0 snapshot records from 004:
-- reputation_records keeps its existing writer/reader contract.
-- These tables add the missing pieces: durable per-agent state plus
-- an append-only, idempotent event log with before/after impacts and
-- human-readable reasons.
--
-- Privacy: reason text and reason codes only — NEVER raw activity,
-- text snippets, metadata, secrets, credentials, wallet data, or
-- evidence content. Same PRIVATE convention as bonds (002).
--
-- agent_reputation is one row per agent (upsert-only, no DELETE
-- endpoint). reputation_events is immutable: no UPDATE/DELETE
-- endpoint exists. Duplicate application of the same protocol
-- outcome is prevented by UNIQUE (agent_id, source_type, source_id)
-- plus deterministic event ids; writers use ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS agent_reputation (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  score INTEGER NOT NULL,
  trust_level TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reputation_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  impact INTEGER NOT NULL,
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  reputation_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS reputation_events_agent_time_idx
  ON reputation_events(agent_id, created_at DESC);
