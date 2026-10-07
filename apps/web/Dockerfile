# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
# Production API origin, baked in at build time (Vite semantics).
# A production image MUST NOT be producible without it: an empty
# VITE_API_URL fails the build here (structural prevention), and the
# app additionally refuses the localhost default at runtime
# (see resolveApiBase). Local development uses `npm run dev:web`,
# never this image, so no dev convenience is lost.
ARG VITE_API_URL
RUN if [ -z "$VITE_API_URL" ]; then echo "ERROR: VITE_API_URL build-arg is required (e.g. --build-arg VITE_API_URL=https://api.example.com); refusing to bake a localhost production bundle." >&2; exit 1; fi
ENV VITE_API_URL=${VITE_API_URL}
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/sdk/package.json ./packages/sdk/
RUN npm install --ignore-scripts
COPY packages/shared-types ./packages/shared-types
COPY packages/sdk ./packages/sdk
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN npm run build --workspace=@bond/sdk && npm run build --workspace=@bond/sdk && npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
