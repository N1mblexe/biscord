# Build context: repo root (docker compose sets `context: .`).

FROM node:26-alpine AS build
RUN npm install -g pnpm@12.6.0
WORKDIR /app

# Manifests first so the dependency layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @hearth/web...

# @hearth/shared is bundled from its TS source via the `hearth-src` condition, so no separate build.
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @hearth/web build

FROM caddy:2.11.4-alpine AS runtime
# Run as an unprivileged user. Every listener is above 1024 (8080 locally, 8443/7443 in the LAN profile),
# so no cap_net_bind_service is needed here; the prod image (Phase 9) handles 80/443.
RUN addgroup -S caddy && adduser -S -D -H -G caddy caddy && chown -R caddy:caddy /data /config
COPY --from=build /app/apps/web/dist /srv
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
USER caddy
EXPOSE 8080
