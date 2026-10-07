-- 016: agent-to-agent delegation (Phase 23, OFF-CHAIN only).
--
-- delegations: bounded authority grants from a delegator agent to a
-- delegate agent. Capabilities are authentication capabilities only
-- (activity:submit, agent:read, risk:read, verification:read,
-- reputation:read) — never enforcement, withdrawal, or policy-write
-- authority (those routes are operator-only and unreachable with an
-- agent principal, delegation or not).
--
-- Lifecycle: ACTIVE → REVOKED (durable, never deleted). Expiry is
-- evaluated dynamically against expires_at (the security authority);
-- status is materialized to EXPIRED opportunistically for query
-- hygiene. version counts lifecycle transitions for audit.
--
-- No secrets in delegation records, ever. Attribution columns on
-- the ledger preserve (requester, executor, delegation) per
-- analyzed activity without duplicating the activity model.
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  delegator_agent_id TEXT NOT NULL REFERENCES agents(id),
  delegate_agent_id TEXT NOT NULL REFERENCES agents(id),
  capabilities JSONB NOT NULL DEFAULT '[]',
  scope JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  CHECK (delegator_agent_id <> delegate_agent_id)
);
CREATE INDEX IF NOT EXISTS delegations_delegator_idx
  ON delegations(delegator_agent_id);
CREATE INDEX IF NOT EXISTS delegations_delegate_idx
  ON delegations(delegate_agent_id);
CREATE INDEX IF NOT EXISTS delegations_status_idx
  ON delegations(status);
CREATE INDEX IF NOT EXISTS delegations_expires_idx
  ON delegations(expires_at);

ALTER TABLE agent_activity_ledger
  ADD COLUMN IF NOT EXISTS requester_agent_id TEXT REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS delegation_id TEXT REFERENCES delegations(id);
