-- 006: purpose-specific params for chain transactions (e.g. enforcement
-- decision references). Opaque JSONB; validated in TypeScript.
ALTER TABLE chain_transactions ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}';
