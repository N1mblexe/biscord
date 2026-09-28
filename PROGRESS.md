# Hearth — Progress

Updated at the end of every phase (see CLAUDE.md → Workflow).

## Phase 2 — Accounts & auth ✅ (2026-09-28)

### Built

- **Server:**
  - Invite-only registration in one transaction: an advisory lock, the user cap, a conditional invite redemption, and a `USERNAME_TAKEN` rollback. A cheap invite check runs before any argon2 hashing.
  - Login and logout. argon2id password hashing, with a dummy-hash verify for unknown users so timing doesn't reveal them.
  - DB sessions: only the sha256 of the token is stored. The expiry slides forward at most once an hour, and the cookie is re-sent each time.
  - Profile edit (`user:updated`), change password (revokes your other sessions), admin reset codes (single use, 24 h), and reset password (revokes all sessions).
  - Admin invites (create, list, revoke) and `GET /users`.
  - Rate limits: login, register, reset and invite check, each 10 per minute per IP.
  - `TRUST_PROXY` is now a list of trusted proxy IPs/CIDRs, never `true`.
  - The test-only reset endpoint.
  - A bootstrap CLI that prints the first admin invite.
  - Socket.IO:
    - The handshake checks `Origin` and the session cookie.
    - Each socket joins `all`, `user:<id>` and `session:<id>`.
    - Revoking a session sends `session:revoked`, then disconnects the socket.
  - The fatal startup log now includes the underlying error.
- **Web:**
  - React Router 8 in data mode; loaders guard the user, admin and public pages.
  - A typed API client that sends the CSRF header and validates every response.
  - Login, register, reset-password, home, settings, admin invites and admin reset-code pages.
  - A websocket-only socket client that handles revocation.
- **e2e:**
  - Fixtures: an automatic `resetDb`, a multi-user `users([...])` helper with one browser context per user, and `api()`.
  - Six auth scenarios, plus the smoke test moved to `/login`.
- **Infrastructure:** the compose network has a fixed subnet, and Caddy's IP (`172.28.0.10`) is the only trusted proxy.

### Tested (run for real on 2026-09-28)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 209 tests (shared 66, web 34, server 109), run with shared `dist/` deleted.
- `pnpm test:e2e --repeat-each=3` ✅: 27/27 (9 specs × 3), no flakes.
- `docker compose up --build` ✅.
  - The `@smoke` specs pass against :8080.
  - Manual check through Caddy: register (201), then the session cookie authenticates the WebSocket.
  - The 11th bad login gets 429.
  - Forged `X-Forwarded-For` sent directly to :3000 doesn't get a fresh rate-limit bucket.
  - The bootstrap CLI works inside the container.
- A fresh review found 0 blockers, 1 major and 6 minor issues; all are fixed and covered by tests.

### Known issues / notes

- The e2e auth specs need test mode, so they only run in dev-server mode. The full stack runs only the `@smoke` specs.
- Vite's WebSocket proxy logs `EPIPE`/`ECONNRESET` when the server deliberately drops revoked sockets during e2e. This is harmless noise.
- Changing the compose network definition can leave already-running containers without their DNS alias (for example `postgres`). Recover with `docker compose down && docker compose up -d`; volumes are kept.
- A locked git worktree from another Claude session exists at `.claude/worktrees/docs-local-testing`. It's now ignored by ESLint, Prettier and git; I didn't touch it.
- The web bundle is about 510 kB (mostly zod). Code-splitting comes later.
- Carried over from Phase 1: `UPLOAD_DIR` path resolution (Phase 5) and Caddy running as root (Phase 9).

### Next step

Phase 3: text channels, DMs, messaging. The plan is in `docs/plans/phase-3.md`, waiting for approval.

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
