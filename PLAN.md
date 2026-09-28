# Hearth — PLAN.md

This is the source of truth for what Hearth is and the order it gets built in. Binding API, database and event
contracts live in [docs/CONTRACTS.md](docs/CONTRACTS.md). Working rules live in [CLAUDE.md](CLAUDE.md).

## 1. Goal
Hearth is self-hosted, private chat plus voice for one friend group:
- 6–8 people, with a hard cap of 25 accounts.
- One community ("the hearth"), invite-only.
- Runs on a single small VM (Oracle Cloud Always Free, arm64) behind Caddy with HTTPS.

**Out of scope for v1:** multiple servers/guilds, group DMs, voice/video calls in DMs, private channels or
per-channel permissions, `@everyone`, message search, link previews/embeds, bots/webhooks, email (no SMTP),
native/mobile apps, end-to-end encryption, federation, off-box backups.

## 2. Users and roles
- There are two roles: `admin` and `member`. A bootstrap CLI creates the first admin by printing a one-time admin invite.
- Registration works only with an invite code. Admins create them; `maxUses` defaults to 1, `expiresAt` to 7 days, and they can be revoked.
- Invariant: there is always at least one active admin. The last admin cannot demote or deactivate themselves (409 `LAST_ADMIN`).
- **Admin** can:
  - manage channels, invites and roles;
  - deactivate and reactivate users, and issue password-reset codes;
  - delete any non-DM message;
  - disconnect anyone from voice.
- **Member** can:
  - read and write all text channels and join all voice channels;
  - DM any active user;
  - edit and delete their own messages, upload files, react;
  - edit their own profile and change their own password.
- Deactivation is a soft delete:
  - sessions are revoked, sockets force-closed, and the user is removed from LiveKit;
  - their messages are kept and shown as "Deleted user";
  - the username stays reserved.

## 3. Features
1. **Accounts:**
   - Username `^[a-z0-9_]{3,32}$`, display name 1–32 characters, password 10–128 characters (hashed with argon2id).
   - Avatar: png/jpeg/webp up to 2 MB.
   - Session: an opaque token in an httpOnly cookie, stored hashed in the DB, with a 30-day sliding expiry.
   - Password reset: an admin generates a one-time code (valid 24 h), the user sets a new password, and all sessions are revoked.
2. **Text channels:**
   - Admins create, rename, reorder and delete them.
   - Messages use a safe Markdown subset (react-markdown + remark-gfm, no raw HTML), up to 4000 characters and 10 attachments.
   - Authors edit their own messages (shown as "edited"). Authors delete their own; admins can delete any non-DM message.
   - History loads the latest 50, with cursor pagination for older ones.
   - Each channel has an unread indicator (last-read message id) and a typing indicator.
3. **Direct messages:** 1:1, text only, get-or-create. Only the two members can read them. A DM with a deactivated user becomes read-only.
4. **Reactions:** a built-in palette of about 40 emoji, or any single Unicode emoji. At most 20 distinct emoji per message.
5. **Mentions and notifications:**
   - `@username` highlights, with a per-channel mention badge.
   - The browser `Notification` API fires for mentions and DMs while the tab is hidden.
6. **Presence:** online/offline. A user counts as online while they have at least one connected socket.
7. **Uploads:**
   - Any file type up to 25 MB.
   - png/jpeg/gif/webp preview inline; everything else is download-only (SVG never renders inline).
   - Files live on a local disk volume and are served only to authorised users.
8. **Voice channels:**
   - Join/leave; a user can be in only one voice channel at a time.
   - Self mute/deafen, a speaking indicator, and per-user local volume.
   - The participant list is visible in the sidebar to everyone.
9. **Camera and screen share:**
   - Camera up to 720p30.
   - Screen, window or tab sharing up to 1080p30, with optional tab audio.
   - Viewers choose whose video to watch.
10. **Admin panel:** invites, users (role, deactivate/reactivate, reset code), channels.

## 4. Stack (exact versions are pinned in CLAUDE.md)
- **Tooling:** Node 26 (local and in images), pnpm 12 workspaces (`apps/web`, `apps/server`, `packages/shared`), TypeScript 7 strict (ESLint runs on TypeScript 6; see CLAUDE.md).
- **Server:** Fastify 5, @fastify/cookie, @fastify/multipart, @fastify/rate-limit, Socket.IO 4, Drizzle ORM + drizzle-kit (stable 0.x line), `pg`, zod 4, @node-rs/argon2, livekit-server-sdk 2, file-type, tsx (dev), pino-pretty (dev).
- **Web:** React 19, Vite 8, Tailwind CSS 4 (@tailwindcss/vite), react-router, @tanstack/react-query 5, zustand 5, socket.io-client 4, livekit-client 2, @livekit/components-react 2 (hooks only), react-markdown, remark-gfm.
- **Shared:** zod schemas, inferred types, error codes, socket event maps, limits, emoji palette.
- **Infrastructure:** PostgreSQL 17, LiveKit server (pinned tag), Caddy 2.
- **Tests:** Vitest (unit/integration against real Postgres) and Playwright (Chromium, fake media, real LiveKit container).
- **Lint/format:** ESLint (flat config) + typescript-eslint + react-hooks, Prettier, globals.

## 5. Phases
Every phase ends with three things: its acceptance tests pass (run for real), PROGRESS.md is updated, and one commit
`phase N: <summary>` is made. Before coding a phase, write a short plan and get approval.

### Phase 1 — Skeleton, infrastructure, contracts in code
- **Scope:**
  - git repo and pnpm workspaces; strict TypeScript, ESLint and Prettier.
  - `packages/shared` with every contract schema from CONTRACTS.md.
  - Fastify `GET /api/health` (checks the DB), the shared error format, and CSRF header enforcement.
  - Full Drizzle schema and the first migration.
  - A Vite + Tailwind shell that shows the server status.
  - docker-compose (postgres, livekit, server, web/caddy); Vitest and Playwright wired up.
- **Acceptance:**
  - `docker compose up --build` gives `/api/health` = `{status:"ok",db:"ok"}` on :8080.
  - `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
  - `pnpm test:e2e` passes in dev-server mode and against the containers (the page shows "Hearth" and "Server: ok"; LiveKit answers).

### Phase 2 — Accounts & auth
- **Scope:** bootstrap CLI, invites (admin), register/login/logout, sessions, profile, change password, reset codes, authenticated Socket.IO handshake.
- **Acceptance (e2e):**
  - Reset, then register the admin via the invite.
  - The admin creates an invite in the UI, a second user registers, and logout/login works.
  - Used, expired and revoked invites are rejected.
  - Anonymous API calls get 401, and a socket without a cookie is refused.

### Phase 3 — Text channels, DMs, messaging
- **Scope:** channel CRUD and reorder (admin), send/edit/delete, history pagination, DMs, audience routing, reconnect catch-up, Markdown.
- **Acceptance (two browsers):**
  - A posts and B sees it within 1 s; edit and delete propagate.
  - An A↔B DM is invisible to C: 403 over the API and no socket event.
  - Scrolling loads older pages.
  - A client that was offline catches up after reconnecting.

### Phase 4 — Presence, typing, unread, reactions, mentions, notifications
- **Acceptance:**
  - B closes the tab and A sees B go offline within 5 s; the typing indicator shows and clears.
  - Unread and mention badges appear and clear on view, and stay in sync across two tabs.
  - Adding and removing reactions syncs.
  - A mention while the tab is hidden triggers `Notification`.

### Phase 5 — Uploads & avatars
- **Acceptance:**
  - A uploads an image and a PDF; B sees the image inline and the PDF as a download link.
  - 26 MB → 413; an anonymous file URL → 401; C cannot read a DM attachment.
  - An upload aborted midway leaves no DB row and no file.
  - An avatar change reaches other users.

### Phase 6 — Voice (LiveKit)
- **Scope:** token endpoint, webhook receiver, reconcile loop, voice state broadcast, mute/deafen, speaking indicator, per-user volume.
- **Acceptance:**
  - Two fake-media users join the same channel and see each other.
  - Each receives audio (inbound `bytesReceived > 0`).
  - A third user who hasn't joined sees both in the sidebar.
  - Mute state is visible to the others, and switching channels leaves the old one.

### Phase 7 — Camera & screen share
- **Acceptance:**
  - A turns the camera on and B receives the video (`videoWidth > 0`).
  - A shares the (fake) screen and B receives it; stopping the share removes it for B.
  - C sees a LIVE badge in the sidebar.

### Phase 8 — Admin, moderation, hardening
- **Scope:** admin panel, lifecycle rules (CONTRACTS.md B.7), disconnect-from-voice, rate-limit tuning, CSP and security headers, upload GC schedule.
- **Acceptance (one e2e per edge case):**
  - Deactivating a user who is in voice kicks them from voice, closes their socket, blocks their login, and shows their messages as "Deleted user".
  - Demoting the last admin shows a 409 in the UI.
  - Deleting a voice channel with two people in it disconnects both, and both see a notice.
  - Reactivating a user respects the account cap.

### Phase 9 — Production deployment
- **Scope:** `docker-compose.prod.yml`, `Caddyfile.prod`, `livekit.prod.yaml` (host network, UDP 50000–50100, TURN on UDP 3478), backup/restore scripts, and `docs/DEPLOY.md` (OCI security list + iptables, DNS, arm64 notes).
- **Acceptance:**
  - HTTPS works on the VM.
  - Two devices on different networks (one on mobile data) can use voice and screen share.
  - Backup → wipe volumes → restore brings the data back.

## 6. Limits & security
| Item | Limit |
|---|---|
| Active accounts | 25 |
| Channels (text + voice) | 50 |
| Message length | 4000 characters |
| Attachments per message | 10 |
| Upload size | 25 MB (avatar 2 MB) |
| Distinct reactions per message | 20 |
| Message send | 10 per 10 s per user |
| Login / reset attempts | 10 per minute per IP |
| Uploads | 20 per minute per user |

- **Cookies:** `HttpOnly; SameSite=Lax`, plus `Secure` in production.
- **Origin and CSRF:**
  - Same origin only (no CORS).
  - Every non-GET `/api` request must send `X-Requested-With: hearth`.
  - The Socket.IO handshake checks the `Origin` header.
- **Uploads:** MIME type sniffed from content; non-images served as `attachment`; `nosniff` on every file response.
- **Secrets:** only in `.env`, with a committed `.env.example`.
- **Backups:** nightly `pg_dump` plus an uploads tarball, keeping the last 7.

## 7. Deployment
The production setup is a single VM running `docker-compose.prod.yml` with these services:
- caddy
- server (runs migrations on start)
- postgres
- livekit (host network)

Domains:
- `hearth.<domain>` → the web app plus `/api` and `/socket.io`.
- `lk.hearth.<domain>` → LiveKit signaling (wss through Caddy).

Ports to open: TCP 80/443, TCP 7881, UDP 50000–50100 and UDP 3478. On Oracle Cloud, open them in **both** the VCN security list and the VM's iptables.

## 8. Contracts
[docs/CONTRACTS.md](docs/CONTRACTS.md) is binding. Any change to it goes in the same commit as the code that implements the change.
