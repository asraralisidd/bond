# BOND — foundation Docker notes (config only, lightweight for 8 GB RAM)

#

# Implemented:

# - `db` service (postgres:16-alpine) with named volume + healthcheck.

# - `api` + `web` buildable images (see apps/*/Dockerfile).

#

# Planned (not yet implemented):

# - production reverse proxy / TLS, migrations runner, observability.

#

# Unavailable / unverified:

# - Midnight / Compact tooling images. Do NOT add until official images/APIs are verified.

#

# Usage:

# docker compose config # validate without starting anything

# docker compose up -d db # postgres only (recommended on low-RAM laptops)

# docker compose up --build # full stack
