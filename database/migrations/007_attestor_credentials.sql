-- 007: attestor credentials (hashed secrets only; raw secrets never stored).
CREATE TABLE IF NOT EXISTS attestor_credentials (
  attestor_id TEXT PRIMARY KEY REFERENCES attestors(id),
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
