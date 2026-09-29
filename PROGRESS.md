# Hearth — Progress

Updated at the end of every phase (see CLAUDE.md → Workflow).

## Phase 5 — Uploads & avatars ✅ (2026-09-29)

### Built

- **Server:**
  - Uploads stream to `tmp/`. The 25 MiB cap is enforced mid-stream, the type is detected from the file contents (what the client declares is ignored), and the file is then moved into `yyyy/mm/<uuid>`. On any failure the temp file is removed and no row is written.
  - All paths go through one check that keeps them inside `UPLOAD_DIR`. Filenames are cleaned up and never used in a path.
  - `UPLOAD_DIR` resolves against the repo root, which fixes the Phase 1 known issue.
  - Serving files:
    - Only the four inline image types keep their own `Content-Type`. Everything else, including SVG, HTML and XML, is sent as `application/octet-stream` with `attachment`.
    - Every file response has `nosniff` and `default-src 'none'; sandbox`, and filenames are encoded per RFC 5987.
    - Anonymous gets 401. No access, or someone else's pending upload, gets 404.
    - HEAD requests don't read the file.
  - Avatars:
    - PNG, JPEG or WebP only (checked from the content) and at most 2 MB.
    - A replaced or deleted avatar's file is removed after the commit.
    - A `?v=` cache-buster, plus a `user:updated` event.
    - Rate-limited.
  - Deleting a message or channel removes its files after the commit.
  - Disk-fill guards:
    - At most 30 files or 250 MiB of pending uploads per user (`409 UPLOAD_QUOTA`).
    - Uploads are refused below `UPLOAD_MIN_FREE_MB` of free space (`507 STORAGE_FULL`).
  - Upload GC: removes pending uploads older than 24 h, temp files older than 1 h, and files with no row. Runs under a session advisory lock, with a short DB transaction and the disk walk after the commit. Scheduled every `UPLOAD_GC_INTERVAL_MINUTES`.
- **Web:**
  - Attaching files through the picker, drag-and-drop or paste, shown as chips (uploading/ready/failed). Send is disabled while an upload is in progress.
  - Checks before upload: 25 MB and 10 files. Caddy's non-JSON 413 is mapped to the same message.
  - Inline images and download links.
  - An `Avatar` component used everywhere, and an avatar section in Settings.
- **e2e:** 7 upload and avatar scenarios. All test files are generated in memory, and one checks the exact 25 MiB limit.
- **Infrastructure:** Caddy's cap is `max_size 26MiB`. Caddy reads `MB` as 10⁶ bytes, which put its old cap below the server's.

### Tested (run for real on 2026-09-29)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 554 tests (shared 66, web 184, server 304), run with shared `dist/` deleted. Includes a real upload aborted mid-stream (no row, no file) and the disk-fill guards refusing before any body is read.
- `pnpm test:e2e --repeat-each=3` ✅: 90/90 (30 specs × 3), no flakes.
- `docker compose up --build` ✅:
  - `@smoke` passes.
  - Through Caddy, exactly 25 MiB uploads (201) and 27 MB gets 413.
  - The file survives `docker compose restart server` and downloads byte-identical.
  - HEAD returns the `octet-stream`, `attachment`, `nosniff` and sandbox CSP headers.
- A fresh security review found 0 blockers, 2 major and 4 minor issues; all are fixed and tested. There was also one contract gap: an SVG with an `<?xml` line is detected as `application/xml`, so all non-inline files are now served as octet-stream.

### Known issues / notes

- There's no total storage quota per user; only pending uploads are capped. It's a Phase 8 candidate.
- The presence dot slightly overlaps two-letter initials on small avatars. Cosmetic polish for Phase 8.
- Attachments are listed in upload order, not in the order of `attachmentIds`.

### Next step

Phase 6: voice via LiveKit, plus the LAN test profile (`docs/plans/phase-6.md`).

## Phase 4 — Presence, typing, unread, reactions, mentions, notifications ✅ (2026-09-29)

### Built

- **Server:**
  - Presence: tracks each user's sockets, with a 3 s offline grace period. Only real changes are emitted, timers are cleaned up on close and on test reset, and `onlineUserIds` goes into bootstrap.
  - `typing:start`:
    - zod-validated and access-checked;
    - a per-user flood limit runs before any DB access;
    - one broadcast per user and channel every 2 s, to the channel audience minus the sender's own sockets.
  - Read states:
    - forward-only `GREATEST` upsert, with `unread` ignoring your own messages;
    - `mentionCount` from mention rows, and every DM message creates a mention row for the other member;
    - one query computes bootstrap `readStates`;
    - sending a message moves the sender's read state forward in the same transaction;
    - `readstate:updated` goes only to your own sockets.
  - Mentions are parsed server-side on create and edit.
  - Reactions:
    - the 20-distinct-emoji cap is checked under a row lock;
    - events are sent only when something changes;
    - a read-only DM returns FORBIDDEN.
  - A history page costs a fixed 5 queries whatever its size (a test counts them).
- **Web:**
  - Stores for presence, typing, read state and the current view, all reset on logout.
  - Online dots and a typing indicator.
  - Unread and mention badges, synced across tabs. Server state only overrides messages received before its request, so a stale snapshot can't drop a mention.
  - Read marking: debounced, retried after a failure, and only sent while you're at the bottom with the tab visible.
  - Reactions: a bar under each message and an emoji picker dialog (a native `<dialog>`), with optimistic updates rolled back only when they actually changed something.
  - Mention highlighting for known active users only. DMs aren't given the mention highlight style.
  - Opt-in desktop notifications for mentions and DMs while the tab is hidden.
- **e2e:**
  - Helpers: `stubNotifications`, `setHidden`, `openSecondTab`.
  - Channel links are now matched on a `channel-link-name` child.
  - 5 realtime scenarios.

### Tested (run for real on 2026-09-29)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 413 tests (shared 66, web 132, server 215), run with shared `dist/` deleted.
- `pnpm test:e2e --repeat-each=3` ✅: 69/69 (23 specs × 3), no flakes.
- `docker compose up --build` ✅: `@smoke` passes against :8080. Manual Caddy check:
  - a mention is stored, and the mentioned user's read state shows `unread` with `mentionCount: 1`;
  - online and then offline presence events arrive, the offline one after the grace period;
  - reaction PUT returns 204 and is idempotent.
- A fresh review found 0 blockers, 1 major and 7 minor issues; all are fixed with tests.
- Separately, a verifier in an isolated worktree independently re-checked the committed Phases 1–3 and everything passed: clean install, 300 unit tests, e2e 18/18 plus a 36/36 repeat, Docker builds from scratch, a manual API check, and a code-health scan.

### Known issues / notes

- The server counts `@mentions` written inside code spans (they notify), but the client doesn't highlight them there.
- If a snapshot already includes a mention, the badge can briefly count it twice until the next `readstate:updated` corrects it. This is the safe direction of the stale-snapshot fix.
- **The disk filled up during this phase.** The root partition (49 GB, where `/var/lib/docker` lives) hit 100%, and Postgres failed with `53100 No space left on device`.
  - Cause: repeated `docker compose build` runs leave the old images untagged.
  - I removed only untagged Hearth images (`docker image prune -f`, about 7.9 GB) and the verifier's images. Postgres recovered cleanly.
  - After any full-stack rebuild, run `docker image prune -f`.

### Next step

Phase 5: uploads and avatars (`docs/plans/phase-5.md`).

## Phase 3 — Text channels, DMs, messaging ✅ (2026-09-29)

### Built

- **Server:**
  - A single access function (`loadChannelForUser`) decides who can use a channel. A single audience helper (`emitToChannel`) sends text/voice channel events to everyone and DM events to the two members only. Every emit happens after the transaction commits.
  - Channel create, rename, reorder and delete (admin only). The 50-channel cap and the exact-set reorder check hold under concurrency (advisory lock).
  - DM get-or-create, race-safe.
  - Messages: history pages by `before`/`after`, returned in ascending order, with ids as strings (no precision loss). Send, with the nonce echoed back. Edit and delete: admins can delete in text channels but not in DMs.
  - The send rate limit is 10 per 10 s **per user**.
  - `/bootstrap` is staged: channels, DMs and users are real; read states, presence and voice are still empty.
  - The test-only `seed-messages` endpoint.
  - `loggableError` keeps query parameters and row data out of logs.
- **Web:**
  - Sidebar (text channels, voice placeholders, DMs), channel view, composer, inline edit and delete.
  - Safe Markdown: raw HTML turned into plain text, a small allowlist of elements, and safe links.
  - Members panel with a button to open DMs, and an admin channels page (rename, move, delete with a typed confirmation).
  - A zustand message store:
    - merges by id, in order;
    - replaces the optimistic copy by nonce, whichever arrives first;
    - remembers deleted ids so they can't come back;
    - `message:updated` only replaces messages already loaded.
  - Reconnect catch-up:
    - a per-channel `syncedThrough` cursor;
    - runs on every connect, including the first;
    - retries channels whose first load failed.
  - A channel deleted while offline sends the user to `/` with a notice.
  - An event log in e2e builds only.
- **e2e:** the `socketSwitch` WebSocket kill switch (Chromium's offline mode doesn't close WebSockets), chat fixture helpers, and 9 chat scenarios.

### Tested (run for real on 2026-09-29)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 300 tests (shared 66, web 75, server 159), run with shared `dist/` deleted.
- `pnpm test:e2e --repeat-each=3` ✅: 54/54 (18 specs × 3), no flakes.
- `docker compose up --build` ✅: `@smoke` passes against :8080. Manual Caddy check: a message sent over REST reached another user's WebSocket; a DM reached both members and not a third user; that third user reading the DM got 403.
- A fresh review found 0 blockers, 2 major and 8 minor issues. The 2 major and 4 minor were fixed with tests, the docs drift was fixed, and 3 were accepted as known issues (below).

### Known issues / notes

- Retry after a failed send reuses the nonce, but the server doesn't deduplicate by nonce. If the first attempt actually committed, you get a duplicate message.
- Catch-up only fetches new messages. Edits and deletes made while you were offline show up after a reload.
- The list of deleted-message ids on the client grows until logout. That's negligible for this group size.
- Deleting a voice channel only removes the DB row for now; the LiveKit `deleteRoom` step comes in Phase 6. `TODO(phase 5)` markers show where attachment files will be cleaned up.

### Next step

Phase 4: presence, typing, unread, reactions, mentions, notifications (`docs/plans/phase-4.md`).

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
- Carried over from Phase 1: Caddy running as root (Phase 9). (`UPLOAD_DIR` resolution was fixed in Phase 5.)

### Next step

Phase 3: text channels, DMs, messaging (`docs/plans/phase-3.md`).

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
