# Hearth — Progress

Updated at the end of every phase (see CLAUDE.md → Workflow).

## Phase 1 — Skeleton, infrastructure, contracts in code ✅ (2026-09-28)

### Built

- **Monorepo:**
  - pnpm 12 workspaces (`apps/server`, `apps/web`, `packages/shared`) plus an `e2e/` Playwright harness.
  - TypeScript 7 strict in the workspaces; ESLint (type-aware) runs on root TypeScript 6. Prettier.
  - Every dependency pinned exactly (see CLAUDE.md).
- **`packages/shared`:**
  - Every contract from docs/CONTRACTS.md as zod 4 schemas and inferred types: DTOs, requests/responses, the error codes with their HTTP statuses, the `Ack<T>` type, the socket event maps and payload schemas, the limits, and the emoji palette.
  - Consumed from source through the `hearth-src` export condition.
- **`apps/server`:**
  - Fastify 5 app factory with zod-validated env (it refuses production when test mode is on).
  - Shared error format for every error, including Fastify's built-in ones, with no internals leaked on 500.
  - CSRF header hook; `GET /api/health` with a DB check and 503 when degraded.
  - Graceful shutdown with a forced exit after 10 s.
  - Full Drizzle schema (B.1, 11 tables) and migration `0000_init`.
  - Non-root production Dockerfile that runs migrations on start.
- **`apps/web`:** Vite 8 + React 19 + Tailwind 4 shell showing "Hearth" and the server status; a Caddy image serves the static build and proxies `/api` and `/socket.io`.
- **Infrastructure:**
  - `docker-compose.yml` with postgres 17, livekit v1.13.7 (loopback node IP, single UDP port 7882), server, and web/caddy on :8080.
  - A Postgres init script creates `hearth_unit` and `hearth_e2e`.

### Tested (run for real on 2026-09-28)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 99 tests (shared 66, web 7, server 26) against real Postgres (`hearth_unit`), confirmed passing with `packages/shared/dist` deleted.
- `pnpm test:e2e` (dev-server mode, :3100/:5273, `hearth_e2e`) ✅: 3/3 smoke tests.
- `docker compose up --build -d --wait` ✅ → `curl :8080/api/health` = `{"status":"ok","db":"ok"}`; an SPA deep link returns 200; the server runs as `node`.
- `E2E_BASE_URL=http://localhost:8080 pnpm test:e2e` ✅: 3/3 against the containers.
- An independent review pass found 1 blocker, 3 major and 7 minor issues. All were fixed except the notes below.

### Known issues / notes

- In dev, a relative `UPLOAD_DIR=./data/uploads` resolves against `apps/server/` (the server's working directory). e2e passes an absolute path. Decide in Phase 5 whether the server should resolve it against the repo root.
- The Caddy container runs as root (fine locally; revisit in Phase 9 hardening).
- Logger header redaction is defense-in-depth only: Fastify's default serializer doesn't log headers.
- The web bundle includes all of zod through `@hearth/shared` (about 96 kB gzipped). Acceptable for now.

### Next step

Phase 2 — Accounts & auth. Write a short plan and get approval first, including confirming react-router 8 (the pin is 8.4.0; the original plan assumed 7).
