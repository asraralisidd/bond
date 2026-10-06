# Development guide (foundation)

## 1. Environment

- Node >= 20, npm >= 10. Repo pins Node 24 in `.nvmrc`.
- Docker 29 + Compose 2 verified at foundation time (postgres:16-alpine only).
- TypeScript is a local devDependency (`npx tsc --version`); no global `tsc` required.
- Midnight/Compact tooling: **not installed / not verified** — see architecture notes.

## 2. First run

```bash
cp .env.example .env   # edit POSTGRES_PASSWORD for anything shared
npm install
npm run typecheck
npm run lint
npm test
npm run build
docker compose config  # validates compose without starting containers
docker compose up -d db
```

Keep it light on 8 GB RAM: run only `db` in Docker; run `api`/`web` with
`npm run dev:api` / `npm run dev:web` on the host.

## 3. Workspaces

npm workspaces: `apps/*`, `packages/*`. Cross-package imports use
`@bond/*` names. TypeScript project references mirror the workspaces.

| Path         | Run locally                                          |
| ------------ | ---------------------------------------------------- |
| `apps/api`   | `npm run dev --workspace=@bond/api` → `:4000/health` |
| `apps/web`   | `npm run dev --workspace=@bond/web` → `:5173`        |
| `packages/*` | `npm run build --workspace=@bond/shared-types` etc.  |

## 4. Checks before pushing

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
docker compose config
```

## 5. Database (Phase 7: real schema)

- Compose `db` creates database `bond_dev` from `.env` on first start.
- `database/init/00_extensions.sql` enables `pgcrypto`;
  `database/migrations/001–007` create the BOND schema (see
  `docs/phase-7/README.md`).
- Run migrations: `DATABASE_URL=... npm run db:migrate --workspace=@bond/api`.
- API tests need PostgreSQL: set `TEST_DATABASE_URL` (each test file
  uses an isolated `bond_test_<name>` database, created automatically;
  `TEST_ADMIN_DATABASE_URL` defaults to `bond_dev` for that).
- If host port 5432 is taken, point `DATABASE_URL`/`TEST_DATABASE_URL`
  at your container port (e.g. a postgres on `5544`).

## 6. Troubleshooting

- `EADDRINUSE :4000/:5173` → stop the other dev server or change `API_PORT`.
- `docker compose up db` fails with `address already in use` on `:5432` → a
  host PostgreSQL is already running. Either stop it or set
  `POSTGRES_PORT=5433` in `.env` (and update `DATABASE_URL` accordingly).
- `docker compose up db` fails on Postgres data → `docker compose down -v`
  **wipes local dev data**; only do this intentionally.
- Workspace `tsc -p` (e.g. in `apps/web`) resolves `@bond/*` from `dist/`, so
  run `npm run build` once after a fresh clone. The root `npm run typecheck`
  and `npm test` work without a prior build (source aliases).
- Vite can't reach API → check `VITE_API_URL` in `.env` and API CORS origin.
