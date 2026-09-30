# Hearth

Hearth is a private, self-hosted chat and voice app for one group of friends (6–8 people, at most 25 accounts). It
works like a small Discord server: text channels, direct messages and voice channels with camera and screen share,
all in the browser. There is one community, registration is invite-only, and everything runs on a single small VM
(Oracle Cloud Always Free) behind Caddy with HTTPS. Media goes through a self-hosted [LiveKit](https://livekit.io)
server; the rest is a Fastify + Socket.IO server with PostgreSQL and a React web app.

## Features

- **Text chat:** channels with a safe Markdown subset, edit and delete, history that loads older messages as you
  scroll, unread badges and typing indicators.
- **Direct messages:** 1:1, visible only to the two people in them.
- **Reactions:** a built-in emoji palette or any single emoji.
- **Mentions and notifications:** `@username` highlights, mention badges, and desktop notifications for mentions and
  DMs while the tab is in the background (opt-in).
- **Presence:** who's online.
- **Uploads and avatars:** any file up to 25 MB (images preview inline, everything else downloads), and profile
  avatars.
- **Voice:** join and leave, mute and deafen, a speaking indicator and per-person volume. Everyone sees who's in which
  voice channel.
- **Camera and screen share:** camera up to 720p, screen, window or tab up to 1080p30 with optional tab audio; pick
  whose video to watch.
- **Admin tools:** invites, channels, users (roles, deactivate/reactivate, password-reset codes) and disconnecting
  someone from voice.

Not in v1: multiple servers, group DMs, calls in DMs, private channels, search, link previews, bots, email,
mobile apps and end-to-end encryption (full list in [PLAN.md](PLAN.md) §1).

> Screenshots: none yet.

## Requirements

- Node 26 and pnpm 12.6.0 (the exact pnpm version is pinned in `package.json` → `packageManager`)
- Docker with the compose plugin (Postgres and LiveKit run in containers, even in dev)
- Chromium for the e2e tests: `pnpm exec playwright install chromium` (add `--with-deps` only on Debian/Ubuntu)

## Quick start (development)

```bash
pnpm install
cp .env.example .env                       # local-only values; never commit .env
pnpm infra:up                              # Postgres :5432 and LiveKit :7880 in Docker
pnpm db:migrate                            # apply the Drizzle migrations to the `hearth` database
pnpm dev                                   # web on http://localhost:5173 → server on :3000
pnpm --filter @hearth/server bootstrap     # prints a one-time admin invite link (valid 24 h)
```

Open the printed `http://localhost:5173/register?invite=…` link and create the first admin account. From there,
invite others from **Admin → Invites**. `pnpm infra:down` stops the containers (data is kept in Docker volumes).

In dev, `localhost` counts as a secure origin, so the microphone, camera and screen share work without HTTPS.

## Full stack in Docker

```bash
docker compose up --build                             # web (Caddy) on http://localhost:8080
docker compose exec server node dist/cli/bootstrap.js # first admin invite
docker image prune -f                                 # every rebuild leaves the old images behind
```

This runs the production images locally: Caddy serves the web build and proxies `/api` and `/socket.io` to the
server, which runs its migrations on start.

## Other environments

- **LAN testing** (voice with a phone or laptop on the same Wi-Fi, over HTTPS from Caddy's local CA):
  `pnpm lan:up` / `pnpm lan:down`. See [docs/DEPLOY.md → LAN testing](docs/DEPLOY.md#lan-testing-voice-with-devices-on-the-same-wi-fi).
  `pnpm lan:down` also stops Postgres and LiveKit, so run `pnpm infra:up` afterwards for dev.
- **Production** (Oracle Cloud VM, DuckDNS name, Let's Encrypt): step-by-step in
  [docs/DEPLOY.md → Production on Oracle Cloud](docs/DEPLOY.md#production-on-oracle-cloud).

## Checks and tests

```bash
pnpm typecheck         # TypeScript 7 in every workspace, plus the e2e project
pnpm lint              # ESLint (runs on TypeScript 6, see CLAUDE.md)
pnpm format            # Prettier --write  (pnpm format:check to only check)
pnpm test              # Vitest: unit + integration against real Postgres (`hearth_unit`) and LiveKit
pnpm test:e2e          # Playwright: boots its own server on :3100 and web on :5273 (`hearth_e2e`)
```

`pnpm test` and `pnpm test:e2e` need `pnpm infra:up` running. The e2e suite uses Chromium with fake media devices
and the real LiveKit container, so voice, camera and screen share are tested end to end.

**Full-stack smoke test** against a running `docker compose up --build`:

```bash
E2E_BASE_URL=http://localhost:8080 pnpm test:e2e --grep @smoke
```

Optional variables for the logged-in security-header and CSP checks:

| Variable             | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `E2E_USERNAME`       | an existing account on that stack (e.g. the admin you bootstrapped)                       |
| `E2E_PASSWORD`       | its password                                                                              |
| `E2E_VOICE_CHANNEL`  | the name of an existing voice channel, for the voice-join-under-CSP check                 |
| `E2E_LIVEKIT_ORIGIN` | the LiveKit origin(s) the CSP must allow, when not `ws://localhost:7880` (e.g. LAN, prod) |

## Architecture

```
               HTTPS :443 (prod) / http :8080 (local full stack)
  Browser ──────────────────────────────────────────►  Caddy ── serves the web build (React SPA)
  (React SPA)                                            │
     │                                                   │ /api (REST), /socket.io (WebSocket)
     │                                                   ▼
     │                                         server (Fastify + Socket.IO) ◄──► PostgreSQL
     │                                           │               ▲                + uploads volume
     │                                           │ room API      │ webhooks
     │                                           │ (kick,        │ (join/leave,
     │                                           │  reconcile)   │  room ended)
     │  signalling: wss://lk.<domain> via Caddy  ▼               │
     └─────────────────────────────────────►  LiveKit ───────────┘
        media: UDP 50000–50100, TCP 7881 fallback (prod)
```

- The browser talks to one origin for the app (no CORS). Non-GET API calls carry `X-Requested-With: hearth`,
  and the Socket.IO handshake checks `Origin` and the session cookie.
- For voice, the browser asks the server for a short-lived LiveKit token (`POST /api/voice/:channelId/token`,
  CONTRACTS.md B.4 row 29 and B.6), then connects to LiveKit directly. The server receives LiveKit's webhooks and
  periodically reconciles its voice state with LiveKit's room list. Hearth never runs its own WebRTC, signalling or
  TURN code: all media goes through LiveKit.
- Locally (dev, e2e, full stack) the browser reaches LiveKit at `ws://localhost:7880` with media on UDP 7882.
- Every socket event from a client is validated with zod, and broadcasts happen only after the DB write commits.

Ports, URLs and env per environment (dev, e2e, unit, full stack, LAN, prod) are in
[docs/CONTRACTS.md → B.8](docs/CONTRACTS.md#b8-runtime-topology-ports-urls-env).

## Project layout

```
apps/
  server/          Fastify + Socket.IO API
    src/routes/    REST endpoints          src/services/   business logic and DB access
    src/realtime/  sockets, presence       src/livekit/    tokens, webhooks, reconcile
    src/storage/   uploads on disk + GC    src/cli/        bootstrap, livekit-test-token
    src/db/        Drizzle schema          drizzle/        SQL migrations
  web/             React 19 + Vite + Tailwind 4 (pages/, components/, stores/, voice/, api/)
packages/
  shared/          zod schemas, types, error codes, socket event maps, limits, emoji palette
e2e/               Playwright specs and fixtures
infra/
  caddy/           Caddyfile (local), Caddyfile.lan, Caddyfile.prod
  livekit/         livekit.yaml (local), livekit.lan.yaml, livekit.prod.yaml
  postgres/init/   creates the hearth_unit and hearth_e2e databases
  scripts/         lan-up/down, gen-secrets, backup, restore, deploy, status
docker-compose.yml        local full stack (dev/e2e use only postgres + livekit)
docker-compose.lan.yml    LAN test overlay
docker-compose.prod.yml   production (Oracle Cloud)
```

## Docs

| File                                   | What it holds                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| [PLAN.md](PLAN.md)                     | the spec: goal, roles, features, stack, phases, limits (source of truth)            |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | binding DB schema, REST endpoints, socket events, LiveKit and lifecycle rules, env  |
| [docs/DEPLOY.md](docs/DEPLOY.md)       | LAN testing and the production runbook (VM, DNS, firewall, backups, updates)        |
| [docs/plans/](docs/plans/)             | the approved plan for each phase (2–9) and the polish pass, including UI test hooks |
| [PROGRESS.md](PROGRESS.md)             | what's built and tested per phase, known issues, and what's still pending           |
| [CLAUDE.md](CLAUDE.md)                 | working rules, commands, pinned versions and gotchas                                |

A change to an API, DB or event contract updates docs/CONTRACTS.md in the same commit. Schema changes go only through
Drizzle migrations (`pnpm db:generate` after editing `apps/server/src/db/schema.ts`, then `pnpm db:migrate`).

## Security notes

- **Invite-only.** There's no open sign-up; admins create invites (single use and 7 days by default, revocable).
  There's always at least one active admin, and deactivated users lose their sessions, sockets and voice at once.
- **Sessions** are opaque tokens in `HttpOnly; SameSite=Lax` cookies (`Secure` in production), stored hashed,
  with a 30-day sliding expiry.
  Passwords are hashed with argon2id. Login, reset, message send, uploads and admin actions are rate-limited.
- **Headers:** Caddy sets a strict Content-Security-Policy (only the app itself and the LiveKit origin),
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, and HSTS in production. Uploaded files are type-sniffed
  from their content, served only to people who can see them, and non-images are always downloads.
- **Secrets** live only in `.env` (dev) and `.env.prod` (production, generated by `infra/scripts/gen-secrets.sh`,
  mode 600). Never commit them.
- **Test mode** (`HEARTH_TEST_MODE`) exposes a reset endpoint for e2e; the server refuses to boot with it in
  production.
- **Backups** contain every message and password hash: keep your copies private.

## Maintenance (production)

All on the VM, with `hc` as the compose alias from [docs/DEPLOY.md](docs/DEPLOY.md) step 5:

- **Update:** `infra/scripts/deploy.sh` makes a pre-deploy backup, pulls, rebuilds, restarts and tags the release
  (`deploy-YYYYMMDD`). Roll back with `infra/scripts/deploy.sh --ref deploy-<date>` (plus a restore if the release
  changed the database; `deploy.sh` prints the exact commands).
- **Backups:** the `backup` container makes a nightly `pg_dump` + uploads tarball into `data/backups/` and keeps 7.
  `infra/scripts/backup.sh` makes one now. **Copy them off the VM every week** (they live on the same disk as the
  database), e.g. `rsync -av ubuntu@<ip>:hearth/data/backups/ ~/hearth-backups/`.
- **Restore:** `infra/scripts/restore.sh data/backups/<timestamp>` (asks for confirmation and backs up the current
  state first). Do the restore drill from DEPLOY.md once after the first deploy.
- **Health:** `infra/scripts/status.sh` (health endpoint, containers, disk, backup age, certificate expiry) and
  `hc logs --since 1h server`.
- **Disk:** `docker image prune -f` after rebuilds.
