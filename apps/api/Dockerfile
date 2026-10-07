# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/risk-engine/package.json ./packages/risk-engine/
COPY packages/policy-engine/package.json ./packages/policy-engine/
COPY packages/attestor/package.json ./packages/attestor/
COPY packages/contract/package.json ./packages/contract/
COPY packages/midnight-adapter/package.json ./packages/midnight-adapter/
COPY packages/sdk/package.json ./packages/sdk/
RUN npm ci
COPY packages ./packages
COPY contracts ./contracts
COPY database ./database
COPY apps/api ./apps/api
WORKDIR /app/apps/api
# Build @bond workspaces in dependency order before the API itself.
RUN npm run build --workspace=@bond/shared-types \
 && npm run build --workspace=@bond/risk-engine \
 && npm run build --workspace=@bond/policy-engine \
 && npm run build --workspace=@bond/attestor \
 && npm run build --workspace=@bond/contract \
 && npm run build --workspace=@bond/midnight-adapter \
 && npm run build --workspace=@bond/api

FROM node:20-alpine AS runtime
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* /app/
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/api/dist ./dist
# Workspace symlinks in node_modules resolve to these directories.
COPY --from=build /app/packages /app/packages
# Default ZK asset path (overridable via BOND_ZK_ASSETS_PATH).
COPY --from=build /app/contracts /app/contracts
# SQL migrations for manual `db:migrate` runs (never auto-applied).
COPY --from=build /app/database /app/database
COPY --from=build /app/node_modules /app/node_modules
EXPOSE 4000
CMD ["node", "dist/index.js"]
