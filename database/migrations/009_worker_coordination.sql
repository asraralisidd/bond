-- 008: worker coordination fields on chain_transactions (Phase 9.4).
--
-- Operational columns only: the public domain lifecycle
-- (IDLE → … → CONFIRMED / FAILED) is unchanged. A row is claimable
-- when it is PENDING, due (next_attempt_at passed or unset), and
-- unclaimed or its lease expired. reconciliation_required marks rows
-- whose REAL submission outcome was uncertain: they must be resolved
-- by reconciliation, never by blind resubmission. dead_letter marks
-- terminal failures after bounded retries.
ALTER TABLE chain_transactions
  ADD COLUMN IF NOT EXISTS claimed_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dead_letter BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS chain_tx_claim_idx
  ON chain_transactions(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS chain_tx_reconcile_idx
  ON chain_transactions(reconciliation_required)
  WHERE reconciliation_required;
