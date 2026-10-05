# Architecture notes — foundation vs. planned vs. unverified

## A. Implemented foundation (verified by `npm run build` / `npm test`)

- npm workspaces monorepo (`apps/*`, `packages/*`) with TypeScript project
  references.
- `apps/api`: Express shell with `GET /health` → `{ status, version, service }`.
- `apps/web`: React + Vite shell that fetches `/health` and renders status.
- `packages/shared-types`: `HealthResponse`, `ApiResponse<T>` transport types.
- `packages/risk-engine`, `packages/attestor`, `packages/midnight-adapter`:
  export only `*_STATUS = "not-implemented"` plus a stub that throws.
- ESLint 9 (flat config) + Prettier + Vitest foundation suite.
- `.env.example` for `API_*`, `VITE_*`, `POSTGRES_*`, `DATABASE_URL`.
- `docker-compose.yml`: `db` (postgres:16-alpine, volume, healthcheck),
  buildable `api` (node:20-alpine) and `web` (nginx:1.27-alpine) services.
- `database/init/00_extensions.sql`: `pgcrypto` only. No domain schema.
- `contracts/`: intentionally empty directory with README.

## B. Planned functionality (explicitly NOT implemented)

1. BOND domain model: agents, collateral positions, slash events, policies.
2. AI Risk Engine: feature extraction, scoring function, thresholds, audit trail.
3. Attestor: key management, signing, verification, replay protection.
4. ZK privacy layer: statement definitions, prove/verify flow.
5. Midnight integration: network config, Compact contracts in `contracts/`,
   generated TS bindings consumed via `packages/midnight-adapter`.
6. Database: migration tool + versioned BOND schema + seeds.
7. Auth, API versioning, pagination, error taxonomy, OpenAPI.
8. CI (typecheck/lint/test/build), observability, production hardening.

## C. Unavailable / unverified functionality

- Midnight / Compact toolchain: no `compact` binary, SDK, or docs were found in
  this environment at foundation time. Nothing here assumes or invents those APIs.
- No ZK proving system is wired. `midnight-adapter` documents this explicitly.
- No blockchain node, indexer, or testnet connection exists.
- Any reference to slashing/collateral execution is aspirational until (B) lands.

## D. Constraints respected

- No Kubernetes, Kafka, Elasticsearch, Redis, or service mesh (per scope).
- Images pinned to `-alpine` variants; default local flow runs only `db` in
  Docker to stay comfortable on 8 GB RAM.
- No fake chain: shells throw `not-implemented` instead of simulating results.
