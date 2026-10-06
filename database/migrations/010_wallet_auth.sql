-- 010: wallet challenge-response authentication (Phase 11).
--
-- wallet_challenges: single-use, short-lived login nonces. The nonce is
-- server-generated randomness; the signature is verified against the
-- exact expected message and NEVER stored (only the challenge outcome:
-- which verifying key it bound to).
-- sessions.auth_method: distinguishes wallet sessions from interim dev
-- sessions. sessions.wallet_verifying_key snapshots the bound key so a
-- later wallet change is detectable (stale sessions cannot silently
-- follow an account switch at the API layer).
CREATE TABLE IF NOT EXISTS wallet_challenges (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL,
  -- Canonical message issued to the wallet: the EXACT bytes the wallet
  -- must sign. Stored verbatim so verification never depends on
  -- timestamp re-formatting (PG to_char vs JS toISOString differ).
  message TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  consumed_by_session TEXT NULL,
  -- The verifying key that successfully consumed this challenge (audit
  -- trail; identity comes from the signature, not from a claim).
  verified_verifying_key TEXT NULL
);
CREATE INDEX IF NOT EXISTS wallet_challenges_expires_idx
  ON wallet_challenges(expires_at);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'dev',
  ADD COLUMN IF NOT EXISTS wallet_verifying_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS challenge_id TEXT NULL;
