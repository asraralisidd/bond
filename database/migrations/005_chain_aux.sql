-- 005: eligibility, nullifiers, transactions, idempotency, events, sync.
-- protocol_events is append-only: enforced by trigger (no UPDATE/DELETE).
CREATE TABLE IF NOT EXISTS eligibility_proofs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  bond_id TEXT NOT NULL REFERENCES bonds(id),
  policy_version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  required_minimum_minor_units TEXT NOT NULL,
  proof_nullifier TEXT NOT NULL UNIQUE,
  redemption_nullifier TEXT UNIQUE,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  tx_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eligibility_agent_idx ON eligibility_proofs(agent_id);

-- Local single-use registry. Dedupe aid only: Midnight consumption is
-- authoritative for chain effects.
CREATE TABLE IF NOT EXISTS nullifiers (
  domain TEXT NOT NULL,
  key TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, key)
);

CREATE TABLE IF NOT EXISTS chain_transactions (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  bond_id TEXT REFERENCES bonds(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  chain_tx_id TEXT,
  nullifier TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chain_tx_status_idx ON chain_transactions(status);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  route TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  response_snapshot JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocol_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  bond_id TEXT REFERENCES bonds(id),
  tx_id TEXT REFERENCES chain_transactions(id),
  actor TEXT NOT NULL,
  policy_version TEXT,
  request_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS protocol_events_agent_idx ON protocol_events(agent_id);
CREATE INDEX IF NOT EXISTS protocol_events_type_idx ON protocol_events(type);

CREATE OR REPLACE FUNCTION forbid_protocol_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'protocol_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protocol_events_no_update ON protocol_events;
CREATE TRIGGER protocol_events_no_update
  BEFORE UPDATE OR DELETE ON protocol_events
  FOR EACH ROW EXECUTE FUNCTION forbid_protocol_event_mutation();

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  contract_address TEXT PRIMARY KEY,
  last_marker TEXT,
  conflicts_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
