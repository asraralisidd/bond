# BOND — Privacy-Preserving Collateral & Automated Slashing for AI Agents

> **Scope: development foundation only.** No BOND business logic, risk engine,
> attestor, ZK proof, Midnight/Compact, or blockchain functionality is
> implemented in this repository state.

## Monorepo layout

```text
bond/
├── apps/
│   ├── web/                  # React + Vite frontend shell
│   └── api/                  # Express API shell (GET /health)
├── packages/
│   ├── shared-types/         # Transport-level TS types (HealthResponse, ApiResponse)
│   ├── risk-engine/          # SHELL — throws not-implemented
│   ├── attestor/             # SHELL — throws not-implemented
│   └── midnight-adapter/     # SHELL — throws not-implemented, no APIs assumed
├── contracts/                # EMPTY — reserved for future Compact contracts
├── database/                 # Config only — pgcrypto extension, no BOND schema
├── tests/                    # Foundation vitest suite
├── docs/                     # development.md, architecture-notes.md
└── infra/                    # Docker/Compose notes
```

## Prerequisites

- Node.js >= 20, npm >= 10
- Docker + Docker Compose (only `db` required for local dev)
- PostgreSQL client optional (`psql`) for inspecting `bond_dev`

## Quick start (lightweight, 8 GB RAM friendly)

```bash
cp .env.example .env
npm install
npm run typecheck
npm run lint
npm test
npm run build

# Postgres only (recommended on low-RAM laptops):
docker compose up -d db

# Full stack:
docker compose up --build
```

- Web dev: `npm run dev:web` → http://localhost:5173
- API dev: `npm run dev:api` → http://localhost:4000/health
- Web preview of production build is served by nginx on `:8080` in compose.

## Scripts

| Command             | Purpose                            |
| ------------------- | ---------------------------------- |
| `npm run dev:api`   | Start API with hot reload (`tsx`)  |
| `npm run dev:web`   | Start Vite dev server              |
| `npm run build`     | Build all workspaces               |
| `npm run typecheck` | `tsc --noEmit` across the monorepo |
| `npm run lint`      | ESLint (zero warnings allowed)     |
| `npm test`          | Vitest run (foundation suite)      |
| `npm run format`    | Prettier write                     |

## What is NOT implemented

See `docs/architecture-notes.md` for the implemented / planned / unverified split.
In short: risk scoring, attestations, ZK proofs, Midnight integration, Compact
contracts, slashing, and the BOND database schema do not exist yet — by design.
