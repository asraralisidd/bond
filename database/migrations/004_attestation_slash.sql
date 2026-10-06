-- 004: attestors, attestations, slash events, reputation (OFF-CHAIN
-- records; slash_events mirrors chain outcomes and is immutable once
-- completed — enforced by application rule + tests, see 005 trigger note).
CREATE TABLE IF NOT EXISTS attestors (
  id TEXT PRIMARY KEY,
  organization TEXT NOT NULL,
  status TEXT NOT NULL,
  independence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attestations (
  id TEXT PRIMARY KEY,
  flag_id TEXT NOT NULL REFERENCES risk_flags(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  threshold INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  verdicts JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  decision JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attestations_flag_idx ON attestations(flag_id);
CREATE INDEX IF NOT EXISTS attestations_status_idx ON attestations(status);

CREATE TABLE IF NOT EXISTS slash_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  bond_id TEXT NOT NULL REFERENCES bonds(id),
  attestation_id TEXT NOT NULL REFERENCES attestations(id),
  decision_id TEXT NOT NULL,
  flag_id TEXT NOT NULL REFERENCES risk_flags(id),
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  amount_minor_units TEXT NOT NULL,
  is_full_slash BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  tx_id TEXT,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS slash_events_bond_idx ON slash_events(bond_id);

CREATE TABLE IF NOT EXISTS reputation_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  score INTEGER NOT NULL,
  standing TEXT NOT NULL,
  factors JSONB NOT NULL,
  triggered_by_event TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reputation_agent_idx ON reputation_records(agent_id);
