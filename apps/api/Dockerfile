# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/risk-engine/package.json ./packages/risk-engine/
COPY packages/attestor/package.json ./packages/attestor/
COPY packages/midnight-adapter/package.json ./packages/midnight-adapter/
RUN npm install --ignore-scripts
COPY packages ./packages
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* /app/
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/node_modules /app/node_modules
EXPOSE 4000
CMD ["node", "dist/index.js"]
