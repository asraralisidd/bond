-- 012: operator-delegated setup grants (Phase 19, OFF-CHAIN only).
--
-- A setup grant authorizes exactly ONE setup operation (agent
-- registration, bond init, or attestation init) for the issuing
-- operator. Raw secrets are NEVER stored — only SHA-256(secret_hash),
-- exactly like agent_credentials (011) and attestor_credentials (007).
-- Consumption is single-use enforced by conditional UPDATE
-- (consumed_at IS NULL); concurrent consumers race on the row and
-- exactly one wins. No relationship to Midnight wallet identity.
CREATE TABLE IF NOT EXISTS setup_grants (
  grant_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  agent_id TEXT REFERENCES agents(id),
  scopes JSONB NOT NULL DEFAULT '[]',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revocation_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS setup_grants_operator_idx
  ON setup_grants(operator_id);
CREATE INDEX IF NOT EXISTS setup_grants_agent_idx
  ON setup_grants(agent_id);
CREATE INDEX IF NOT EXISTS setup_grants_expires_idx
  ON setup_grants(expires_at);
