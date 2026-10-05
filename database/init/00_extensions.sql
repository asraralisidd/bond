-- Foundation only: enable UUID generation for future migrations.
-- No BOND domain tables are created here (see database/README.md).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
