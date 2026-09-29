# Hearth — private Discord-like app for 6–8 friends

Full spec: see PLAN.md. It is the source of truth. If something in PLAN.md is ambiguous, ask before guessing.
Binding API/DB/event contracts: docs/CONTRACTS.md. Change it in the same commit as the code that changes a contract.

## Non-negotiable rules

- TypeScript strict everywhere. No `any` without a justifying comment
  (`// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`).
- pnpm workspaces: apps/web, apps/server, packages/shared. Shared types and zod schemas live in packages/shared.
- NEVER write custom WebRTC, signaling, or TURN code. All media goes through LiveKit.
- Every Socket.IO client→server event is validated with zod. Broadcast only after the DB write succeeds.
- Schema changes only via Drizzle migrations.
- Never commit secrets. Use .env with a committed .env.example.
- Ask before adding any dependency not listed in PLAN.md.

## Workflow

- Work ONE phase at a time from PLAN.md section 5.
- Before coding a phase, write a short plan and wait for approval.
- A phase is done only when its acceptance tests pass. Run them yourself; do not claim success without running them.
- For voice and screen-share tests, launch Chromium with:
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --auto-select-desktop-capture-source=Entire screen
  --autoplay-policy=no-user-gesture-required
- After each phase: update PROGRESS.md (built / tested / known issues / next step), then make one git commit with the message "phase N: <summary>".

## Commands (keep this section updated)

- Infra for dev and e2e (Postgres and LiveKit): `pnpm infra:up`
- Dev: `pnpm dev` (web on :5173 → server on :3000)
- DB: `pnpm db:generate` (after editing schema.ts), `pnpm db:migrate`
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm format`
- Test: `pnpm test` (unit, DB `hearth_unit`), `pnpm test:e2e` (Playwright; boots its own server on :3100 and web on :5273, DB `hearth_e2e`)
- First-time e2e setup: `pnpm exec playwright install chromium` (add `--with-deps` only on Debian/Ubuntu; it uses apt)
- Full stack: `docker compose up --build` (web on :8080); smoke-test it with `E2E_BASE_URL=http://localhost:8080 pnpm test:e2e`
- LAN test profile (voice from other devices on the same Wi-Fi): `pnpm lan:up` / `pnpm lan:down` (see docs/DEPLOY.md → LAN testing)

## Pinned versions (verified against the registry on 2026-09-28; change deliberately, one at a time)

- **Runtime and tooling:**
  - node 26 (local and images `node:26-alpine`), pnpm 12.6.0
  - typescript 7.0.2 in each workspace; typescript 6.0.3 in the root, for ESLint only
  - eslint 10.11.0, @eslint/js 10.0.1, typescript-eslint 8.70.1, eslint-plugin-react-hooks 7.1.1, globals 17.12.0, prettier 3.9.9
  - @playwright/test 1.63.0, @types/node 26.6.3
- **Server:**
  - fastify 5.12.5, @fastify/cookie 11.1.2, @fastify/multipart 10.1.2, @fastify/rate-limit 11.2.0
  - socket.io 4.8.4, drizzle-orm 0.45.3, drizzle-kit 0.31.11, pg 8.23.0, @types/pg 8.23.1
  - zod 4.6.5, @node-rs/argon2 2.2.1, livekit-server-sdk 2.19.1, file-type 22.1.1
  - tsx 4.23.15, pino-pretty 13.1.3, vitest 5.0.2
- **Web:**
  - react / react-dom / @types/react / @types/react-dom 19.3.0
  - vite 8.3.1, @vitejs/plugin-react 6.1.1, tailwindcss and @tailwindcss/vite 4.3.3
  - react-router 8.4.0 (confirmed in Phase 2 planning), @tanstack/react-query 5.104.0, zustand 5.0.15
  - socket.io-client 4.8.4, livekit-client 2.22.3, @livekit/components-react 2.9.24
  - react-markdown 10.1.0, remark-gfm 4.0.1
- **Images:** postgres:17-alpine, caddy:2.11.4-alpine, livekit/livekit-server:v1.13.7

## Gotchas

- Mic and screen capture require HTTPS in production. In dev, localhost is fine.
- LiveKit needs TCP 7881 plus a UDP port range open. On Oracle Cloud, open ports in BOTH the VCN security list and the VM's iptables.
- **TypeScript 7 and ESLint:** TypeScript 7 is the native (Go) compiler and has no classic JS API, and typescript-eslint needs that API.
  - Every workspace depends on `typescript@7`, so `tsc` in package scripts is TypeScript 7.
  - The root depends on `typescript@6.0.3` only so ESLint (run from the root) can parse and type-check.
  - Keep tsconfig options valid in both versions.
- **Shared package resolution:** `@hearth/shared` is consumed from source through the custom export condition `hearth-src`.
  - Wired in: tsx `--conditions=hearth-src`, Vite/Vitest `resolve.conditions`, tsconfig `customConditions`.
  - Production builds compile `dist/` and resolve the `default` condition.
- **pnpm 12:**
  - Settings live in `pnpm-workspace.yaml` (`.npmrc` is only for auth/registry).
  - Dependency build scripts need `allowBuilds`, and install fails on unreviewed ones (`strictDepBuilds`).
  - `minimumReleaseAge` defaults to 1 day, so a version published in the last 24 h won't install. Pin the previous release instead.
- **LiveKit:** the API secret must be at least 32 characters. `AccessToken.toJwt()` and `WebhookReceiver.receive()` are async. `RoomServiceClient` takes an http(s) URL, not ws.
- **Tailwind 4:** configuration is CSS-first (`@import "tailwindcss"` and `@theme`); there's no tailwind.config.js.
- **zod 4:** use `z.uuid()`, `z.email()`, `z.iso.datetime()` and `z.flattenError()`. Keep exactly one zod version in the workspace.
- **Socket.IO:** the client must use `transports: ['websocket']`. The handshake checks `Origin`, and browsers don't send it on same-origin polling requests.
- **Disk space:** every `docker compose up --build` leaves the previous images untagged, and the root partition is small (49 GB). Run `docker image prune -f` after full-stack rebuilds.
- **LAN profile:** on a new device, install `data/lan/hearth-lan-root.crt` or open `https://<LAN_IP>:7443` once before joining voice; a wss connection can't show a certificate prompt. `pnpm lan:down` also stops Postgres and LiveKit, so run `pnpm infra:up` afterwards for dev.
- **Test mode:** the server refuses to boot with `NODE_ENV=production` and `HEARTH_TEST_MODE=true`. The reset endpoint exists only in test mode.
