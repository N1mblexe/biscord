# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml, service `server`).

FROM node:26-alpine AS base
RUN npm install -g pnpm@12.6.0
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS build
# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @hearth/server...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @hearth/shared build \
 && pnpm --filter @hearth/server build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile --filter @hearth/server... \
 && mkdir -p /data/uploads \
 && chown -R node:node /data/uploads

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/drizzle apps/server/drizzle

USER node
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
