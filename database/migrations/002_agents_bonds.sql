-- 002: agents + bonds.
-- agents.status is a chain MIRROR (chain wins on conflict); metadata is
-- DB-authoritative. bonds.commitment_minor_units is PRIVATE (digit string).
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  platform TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]',
  external_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'in-sync',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operator_id, platform, external_ref)
);
CREATE INDEX IF NOT EXISTS agents_operator_idx ON agents(operator_id);
CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status);

CREATE TABLE IF NOT EXISTS bonds (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  commitment_minor_units TEXT NOT NULL,
  slashed_total_minor_units TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  chain_tx_id TEXT,
  withdrawal_consumed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live bond per agent: only non-terminal states occupy the slot.
CREATE UNIQUE INDEX IF NOT EXISTS bonds_one_live_per_agent
  ON bonds(agent_id)
  WHERE status IN ('ACTIVE', 'LOCKED', 'PARTIALLY_SLASHED', 'WITHDRAWABLE');
CREATE INDEX IF NOT EXISTS bonds_agent_idx ON bonds(agent_id);
CREATE INDEX IF NOT EXISTS bonds_status_idx ON bonds(status);
