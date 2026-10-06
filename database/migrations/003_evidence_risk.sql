-- 003: evidence descriptors + risk analyses + risk flags (all OFF-CHAIN).
-- Evidence rows carry hashes/pointers only — never raw content.
CREATE TABLE IF NOT EXISTS evidence_descriptors (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  storage_ref TEXT,
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, content_hash)
);

CREATE TABLE IF NOT EXISTS risk_analyses (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  engine_version TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  scoring_version TEXT NOT NULL,
  score JSONB,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_analyses_agent_idx ON risk_analyses(agent_id);

CREATE TABLE IF NOT EXISTS risk_flags (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  analysis_id TEXT REFERENCES risk_analyses(id),
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  model_version TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_flags_agent_idx ON risk_flags(agent_id);
CREATE INDEX IF NOT EXISTS risk_flags_status_idx ON risk_flags(status);
