# database/ — PostgreSQL configuration only (no BOND schema yet)

## Implemented (foundation)

- `docker-compose.yml` (`db` service, postgres:16-alpine) mounts `./database/init`
  into `/docker-entrypoint-initdb.d`.
- `init/00_extensions.sql` enables `pgcrypto` for future UUID generation.
- Connection defaults documented in `.env.example` (`DATABASE_URL`).

## Planned (later milestones)

- Versioned migrations (e.g. `dbmate`, `node-pg-migrate`, or `kysely`).
- Real BOND tables: agents, collateral positions, attestations, slash events.
- Seed data for local development.

## Explicitly NOT done here

- No BOND domain tables are created. Do not treat `bond_dev` as the final schema.
