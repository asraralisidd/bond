-- 011: per-agent API credentials (Phase 18, OFF-CHAIN only).
--
-- Agent credentials are bearer secrets scoped to a single registered
-- agent with an explicit capability allowlist. Raw secrets are NEVER
-- stored — only SHA-256(secret_hash), exactly like attestor_credentials
-- (migration 007). This has no relationship to Midnight wallet identity,
-- ZK identity, or operator sessions; it is purely an API-layer
-- authorization boundary so an agent never needs its operator's session.
CREATE TABLE IF NOT EXISTS agent_credentials (
  credential_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  capabilities JSONB NOT NULL DEFAULT '[]',
  expires_at TIMESTAMPTZ NULL,
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revocation_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_credentials_agent_idx
  ON agent_credentials(agent_id);
-- Auth hot path: lookup by credential id is the PK; this partial index
-- keeps active-credential scans bounded.
CREATE INDEX IF NOT EXISTS agent_credentials_active_idx
  ON agent_credentials(agent_id)
  WHERE status = 'ACTIVE';
