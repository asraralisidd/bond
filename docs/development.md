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

## 5. Database (config only)

- Compose `db` creates database `bond_dev` from `.env` on first start.
- `database/init/00_extensions.sql` enables `pgcrypto` only.
- No BOND tables exist. Add a migration tool (e.g. `node-pg-migrate`) in the
  next milestone before creating domain tables.

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
