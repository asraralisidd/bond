-- 001: operators + sessions (OFF-CHAIN authoritative identity).
-- Wallet columns reserved nullable for the future wallet-login upgrade;
-- Phase 7 uses interim dev sessions only.
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  external_key TEXT NOT NULL UNIQUE,
  wallet_address TEXT,
  wallet_network TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_operator_idx ON sessions(operator_id);
