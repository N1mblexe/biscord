# Hearth — Progress

Updated at the end of every phase (see CLAUDE.md → Workflow).

## Status at a glance (2026-10-01)

- **Done:** Phases 1–8 (the whole v1 feature set: accounts, text channels, DMs, presence, reactions, mentions,
  notifications, uploads, avatars, voice, camera, screen share, admin tools and hardening), each with its
  acceptance tests run for real. Then a whole-app bug hunt, with its fixes merged (CONTRACTS.md B.9).
- **Phase 9 (production):** all the artifacts are done and were dry-run locally (prod compose, Caddy, LiveKit
  config, backup/restore/deploy/status scripts, `docs/DEPLOY.md`). The real VM deploy hasn't happened yet.
- **Done:** the polish pass (`docs/plans/polish.md`): mobile layout, chat UX, visual system and accessibility, and docs (README).
- **Done:** language switching, English + Turkish, saved per account (`docs/plans/i18n.md`, CONTRACTS B.11).
- **Next:** voice and video devices, push-to-talk and audio settings (`docs/plans/devices.md`, CONTRACTS B.12), planned and approved.
- **Pending, needs you:**
  1. **Oracle VM deploy:** create the VM and the DuckDNS name, then follow `docs/DEPLOY.md` → Production on Oracle
     Cloud. Acceptance is listed under Phase 9 → Pending below (valid HTTPS, voice/camera/screen share between two
     networks with one on mobile data, LiveKit's connection test, the restore drill, surviving a reboot).
  2. **LAN phone test:** join voice from a real phone or laptop on the same Wi-Fi (`pnpm lan:up`, then
     `docs/DEPLOY.md` → LAN testing). Only fake-media browsers have been tested so far.
  3. **Turkish copy skim** by a native speaker (see "Language switching → Known issues").

## Language switching (English + Turkish) ✅ (2026-10-01)

### Built

- **Data:** `users.locale` (`en`|`tr`, default `en`, check constraint; migration `0002_user_locale`), `Me.locale`
  (never on `PublicUser`), `RegisterRequest.locale?`, `UpdateMeRequest {displayName?, locale?}` (at least one). A
  locale-only `PATCH /me` emits no `user:updated`.
- **Web i18n core** (`apps/web/src/i18n/`, no dependency): typed `en` dictionaries per namespace (`common`, `auth`,
  `settings`, `admin`, `chat`, `voice`, `errors`, `a11y`) with `tr` typed against them; `t()`/`useT()`, plurals via
  `Intl.PluralRules`, `<Trans>` for markup, `format.ts` (dates, day labels, bytes, numbers, collation, upper-case)
  replacing every ad-hoc `toLocale*`/`localeCompare`; detection (`hearth:language` → `navigator.language` → `en`),
  `<html lang>` sync, `useAccountLocale` (the account wins after login).
- **UI:** every screen translated; Settings → **Language** section (saves to the account, "Language updated.");
  a **Language** picker in the login/register/reset card footer; register sends the language shown. Every
  `ErrorCode` has translated text (English keeps the server's message where it has one).

### Tested (run for real on 2026-10-01)

- `pnpm typecheck`, `lint`, `format:check` green; `pnpm test`: shared 76, web 432, server 465 — all pass
  (parity tests: same keys, placeholders and plural forms in `en` and `tr`; no untranslated `tr` value).
- e2e: new `e2e/tests/i18n.spec.ts` (5 scenarios); full suite 52 passed / 0 failed / 0 flaky (6 full-stack-only
  header checks skipped) ×6 runs, in `en-US`.
- Turkish screenshots at 390 px and 1280 px (login, register, channel, settings, admin users, voice): no clipping
  or overflow.

### Known issues / notes

- Voice-panel buttons wrap to two lines in Turkish in the 240 px sidebar ("Sessize al", "Sağırlığı kaldır",
  "Kamerayı kapat", "Paylaşımı durdur"); nothing is cut off.
- The browser's own file input ("Choose File") follows the browser language, not the app's.
- Words to confirm in the native-speaker skim: "Yönetim" (Admin link), "Bağlantı" (presence column), "Vazgeç",
  "Sese bağlı", "Sağırlığı kaldır".
- Notices and page alerts are translated when shown; switching language while one is visible doesn't re-translate it.

### Next step

Voice and video devices, push-to-talk and audio settings: `docs/plans/devices.md`.

## Polish pass ✅ (2026-09-30)

### Built

- **Mobile (below `md`):**
  - The sidebar and the members list open as drawers (**Open navigation** and **Members**), with a focus trap, focus returned to the opener, and closing on Escape, the backdrop or navigation. DMs can now be started on a phone.
  - The header is one row (53 px, down from 97 px). Admin tables turn into cards. No page scrolls sideways at 390 px; the composer is 234 px wide, up from 24 px.
- **Chat:**
  - A **Jump to latest** pill with a new-message count.
  - Consecutive messages from one author are grouped, with day separators.
  - One tab stop per message; its actions open from it or its "⋯" button.
  - No double page load.
  - **Channel names are unique** regardless of case (migration plus 409 `CONFLICT`, CONTRACTS B.10).
- **Visual design and accessibility:**
  - Documented dark-theme tokens. Contrast: muted text 5.7:1, danger text 5.0:1, white on danger 4.8:1.
  - A global `:focus-visible` ring, and reduced motion is respected.
  - Logo mark and wordmark, polished auth pages, and branded error and loading screens.
  - `ConnectionStatus` shows Connected / Connecting… / Reconnecting… / Offline; the `socket-status` text is unchanged for e2e.
  - Skeletons for message and channel lists, and empty states for the home page, an empty channel or DM, and no DMs.
  - Tidier voice panel and video stage.
- **Screenshot review** at 390 and 1280 px of every main page. Fixed:
  - author names wrapping and pushing the time onto a second line;
  - the DM placeholder being cut mid-letter (it's now an ellipsis overlay);
  - members panel names cut to about 8 characters;
  - the admin table clipping a button's border and focus ring.
- **Docs:** `README.md` (features, quick start, architecture, testing, deployment), "Status at a glance", and accurate plan statuses.

### Tested (run for real on 2026-09-30)

- `pnpm typecheck` / `lint` / `format:check` ✅ · `pnpm test` ✅: 896 (shared 73, web 369, server 454).
- `pnpm test:e2e --repeat-each=3` ✅: 141 passed, 0 failed, 0 flaky, 18 skipped (the full-stack-only header specs).
- Full stack `@smoke` ✅: 9/9.
- At 390 px and 1280 px, `document.documentElement.scrollWidth <= innerWidth` holds on every page.

### Known issues / notes

- The admin "small" buttons have the same padding-class conflict the members panel had, so they render full size. Cosmetic.
- On a phone with two cameras on, the video stage takes about 40 % of the height.

## Bug hunt + fix round ✅ (2026-09-30)

### How it ran

- **Four adversarial hunters,** each with its own Postgres container, writing repro tests: auth/admin, chat/uploads, realtime/voice, web UI.
- **A runtime tester:** full regression plus stress and chaos tests against the Docker stack.
- **Four fix-up agents** in isolated git worktrees, each fixing its area with a regression test that fails before the fix. The branches were merged into `main`.
- **Binding rules** recorded in CONTRACTS.md B.9, plus row 28b.

### Fixed (every item has a failing-before regression test)

- **Auth and security:**
  - Login, change-password and reset races: the user row is locked and the password hash and active state re-checked, so a deactivation or reset mid-login leaves no usable session.
  - CSRF could be bypassed with a percent-encoded path (`/%61pi/...`); the check now uses the matched route.
  - A NUL byte gave 500s; it's now rejected in every shared schema.
  - Reset codes: a deadlock, several valid at once, and codes surviving a password change.
  - `APP_ORIGIN` normalization, Crockford code normalization, and redaction of encoded invite paths.
  - Newer emoji could break channel loading in older browsers; response parsing now tolerates them.
- **Chat and uploads:**
  - A deleted or edited unread mention left a stuck badge; affected users now get a fresh `readstate:updated`.
  - New `DELETE /api/attachments/:id`; the client removes abandoned uploads.
  - Sending while a channel is deleted gave a 500; it's now 404.
  - The upload quota could be overshot by concurrent uploads; it's now enforced under a per-user lock.
- **Realtime and voice:**
  - Switching channels kept the old room's camera and mic live; the old room is now stopped immediately, and the token fetch has a 10 s timeout.
  - A stale bootstrap response could bring back deleted channels or participants.
  - The reconcile could kick a live rejoin.
  - A same-channel LiveKit reconnect wiped mute/deafen and made the participant flicker. A 5 s rejoin grace now applies; a normal leave is still immediate.
  - A `voice:state` rate limit is now retried, deleting the channel you're in makes you leave voice, deactivation racing a join webhook is handled, webhook dedupe only records successes, and the admin voice disconnect re-checks the admin.
- **Web UI:**
  - The specific revoked-session reason is no longer overwritten by "unauthenticated", and logout shows its notice.
  - The hidden message toolbar was clickable; touch screens now get a "⋯" menu.
  - The composer grows with the text and counts length in code points.
  - Friendly validation messages.
  - Focus returns after editing a message.
  - Markdown image alt text and task checkboxes are kept.
  - A file dropped outside the channel view is ignored.

### Tested (run for real on 2026-09-30)

- `pnpm typecheck` / `lint` / `format:check` ✅ · `pnpm test` ✅: 855 (shared 73, web 333, server 449).
- `pnpm test:e2e --repeat-each=3` on the merged `main`: 138 passed and 0 flaky. The 3 failures were one stale spec (`video.spec` 4b expected a page alert that is now an inline field error). The spec is updated and passes 3/3.
- Full stack: `@smoke` 9/9. Checked by hand:
  - an encoded-path CSRF request gets 403;
  - a NUL in the login gets 401;
  - `DELETE /api/attachments/:id` returns 204, then 404 on a repeat;
  - 0 server errors.
- **Stress** (8 users, full stack):
  - 3344 message deliveries with 0 lost, duplicated or out of order; latency p50 13 ms and p95 66 ms (cold), 10/12 ms warm.
  - A reconnect storm of 168 reconnects lost nothing.
  - 25 concurrent uploads succeeded or failed cleanly.
  - 6 people in voice for 2 min: everyone heard everyone, LiveKit used 4–10 % CPU, and an abrupt disconnect converged at 22 s.
  - Server memory stayed flat.
- **LiveKit v1.13.7 disconnect reasons**, observed:
  - a normal leave is `CLIENT_REQUEST_LEAVE`, so it applies immediately;
  - a reload or crash is `PEER_CONNECTION_DISCONNECTED`, so it takes the 5 s grace.

### Known issues / notes

- The earlier accepted Phase 3 notes still stand: a retried send can duplicate, and catch-up doesn't sync edits and deletes.

## Phase 9 — Production deployment (Oracle Cloud + DuckDNS) 🟡 artifacts done, VM deploy pending (2026-09-30)

### Built

- **`docker-compose.prod.yml`** (project `hearth-prod`, arm64):
  - Services:
    - Caddy: ports 80/443 tcp and 443/udp; non-root, using Docker's default unprivileged-port setting;
    - server: bound to `127.0.0.1:3000` only;
    - Postgres: no published port;
    - LiveKit: host network;
    - a backup sidecar.
  - Network `172.29.0.0/24` with the bridge named `hearth-prod0` and Caddy pinned at `.10` (= `TRUST_PROXY`).
  - Config is mounted as read-only directories, so a deploy picks up changes.
  - Healthchecks, restart policies and log caps. Each service gets only the env it needs; Caddy never sees the database secrets.
- **`infra/caddy/Caddyfile.prod`:** Let's Encrypt for `$HEARTH_DOMAIN` and `lk.$HEARTH_DOMAIN`, HSTS on both, the Phase 8 per-header CSP with `wss://lk.` and `https://lk.`, and the 26 MiB body cap.
- **`infra/livekit/livekit.prod.yaml`:**
  - TCP 7881, UDP 50000–50100, TURN/UDP 3478, and 7880 bound to loopback plus the prod bridge gateway only.
  - `rtc.ips.excludes` for Docker's address pools. **The dry run found that without this LiveKit advertised the docker0 bridge as the public mapping, so media would never have reached the VM.**
  - Optional `NODE_IP` to skip STUN.
- **Scripts:**
  - `gen-secrets.sh`: hex secrets, mode 600, refuses to overwrite.
  - `backup.sh`:
    - nightly `pg_dump` plus an uploads tarball, with `SHA256SUMS` and row counts taken from the dump itself;
    - keeps 7 nightly, and 3 each of pre-deploy and pre-restore backups;
    - checks free disk space first and cleans up after a failure.
  - `restore.sh`: typed confirmation, a pre-restore backup, drop and re-create, row-count check, and a trap on failure that prints the recovery command.
  - `deploy.sh`: pre-deploy backup, pull, build, recreate the services whose config changed, deploy tags, rollback instructions.
  - `status.sh`.
- **Server:** `livekit-test-token` CLI for LiveKit's public connection test. Its rooms are `connection-test-*`, never `voice_*`.
- **`docs/DEPLOY.md` → "Production on Oracle Cloud":**
  - Creating the VM (A1, 2 OCPU / 12 GB, reserved IP), with Pay-As-You-Go recommended because of idle reclamation.
  - DuckDNS setup.
  - Both firewall layers: the security list, and iptables inserted before the REJECT rule, then `netfilter-persistent` and a reboot check.
  - Docker, secrets, first deploy, bootstrap, and verification with curl, nc and the connection test.
  - Backups copied weekly to a PC, a restore drill, updates and rollback, troubleshooting, and SSH lockout recovery.

### Tested (run for real on 2026-09-30, locally)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅ · `pnpm test` ✅: 747 (shared 66, web 288, server 393).
- The prod compose config is valid, `caddy validate` passes, and shellcheck is clean. arm64 is published for every base image.
- **Local prod dry run** (hostname `localhost`, Caddy's internal TLS):
  - All 5 services healthy, and LiveKit starts cleanly with the prod config.
  - HSTS and the CSP present; HTTP gets a 308 redirect; 27 MiB gets 413.
  - `@smoke` passes 9/9, including a logged-in voice join with 0 CSP violations.
  - Backup → wipe the volumes → restore: all 11 tables match, and the message and attachment SHA-256 are identical.
  - A deploy with a config change → the container is recreated; rollback works.
- Two reviews (a fresh reviewer, then the dry run): 0 blockers. The 4 major and ~12 minor issues and 4 bugs found in the dry run are all fixed.

### Pending (needs you)

- Create the Oracle VM and the DuckDNS name, then follow `docs/DEPLOY.md`. The real-VM acceptance from `docs/plans/phase-9.md`:
  - HTTPS with a valid certificate;
  - two devices on different networks (one on mobile data) using voice, camera and screen share;
  - LiveKit's connection test;
  - the restore drill;
  - surviving a reboot.
- Check on the VM that LiveKit logs `using external IPs <public>/10.0.0.x`. TURN through Oracle's NAT may not work, which is documented.

### Next step

A detailed test and bug-hunt pass across the whole app, then a polish pass (both with subagents).

## Phase 8 — Admin, moderation, hardening ✅ (2026-09-30)

### Built

- **Server:**
  - One ordered, idempotent lifecycle service (B.7) handles role change, deactivate, reactivate, admin voice disconnect (row 31) and deleting a voice channel with people in it.
  - Last-admin guard and account cap, both under one shared users lock, with the acting admin re-checked inside every admin mutation.
  - Deactivation:
    - revokes sessions and voids the user's unused reset codes and the invites they created;
    - sends `voice:kicked`, then removes them from LiveKit and forces them offline;
    - the re-sync and the join webhook also remove any deactivated user who reappears.
  - `voice:kicked` notices for an admin disconnect and a deleted voice channel. `deleteRoom` also runs again after the commit.
  - Closed a socket race: a session revoked during the connection handshake is disconnected.
  - Rate-limit review, with a 429 test per limit. New: reactions, admin mutations, change password.
- **Web:**
  - `/admin/users` (role, deactivate with a confirm dialog, reactivate, reset code), which replaces `/admin/users/reset`.
  - "Deleted user" shown everywhere, and read-only DMs.
  - Kick notices, and an admin **Disconnect** item in a voice participant's menu.
  - Lazy chunks for the admin pages and the LiveKit voice engine: the first download dropped from 380 kB to 226 kB gzipped. The raw 350 kB target isn't reachable without just moving the same vendor code into other files, so it's measured gzipped.
  - zod runs without its JIT (no `eval`, so no CSP violation).
  - The presence dot no longer covers avatar initials.
- **Infrastructure:**
  - Caddy runs as an unprivileged user (`uid 100`), and `lan-up.sh` re-owns an existing `caddy_data` volume without touching the running stack.
  - Security headers set per header with `?`, so the server's per-file sandbox CSP is kept: CSP (`connect-src` covers LiveKit's ws and http origins), nosniff, `Referrer-Policy`, `Permissions-Policy`, COOP, and no `Server` header.
- **e2e:**
  - 5 admin scenarios.
  - Full-stack header and CSP specs, including a logged-in voice join under the real CSP (it needs `E2E_USERNAME` / `E2E_PASSWORD` / `E2E_VOICE_CHANNEL`).
  - The Phase 2 reset spec moved to `/admin/users`.

### Tested (run for real on 2026-09-29/30)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 745 tests (shared 66, web 288, server 391), run with shared `dist/` deleted.
- `pnpm test:e2e --repeat-each=3` ✅: 141 passed, 18 skipped (the full-stack-only header specs), 0 failed, 0 flaky.
- Full stack ✅:
  - CSP and all headers present, with no `Server` header; web and server run as non-root.
  - `@smoke` 9/9 with a bootstrap account, including the voice join under the CSP, with 0 violations.
- LAN profile ✅:
  - `lan:up` works while dev infra is running; CSP `connect-src` has `wss://` and `https://<LAN_IP>:7443`.
  - A voice join over wss:7443 with 0 CSP violations.
- A fresh security review found 0 blockers, 3 major and 5 minor issues; all are fixed. My own full-stack run also found the zod `eval` CSP violation, and that's fixed too.

### Known issues / notes

- The LAN profile can't run the Playwright `@smoke` suite: global setup rejects the self-signed certificate, and `headers.spec.ts` expects `ws://localhost:7880`. The LAN checks are ad-hoc scripts.
- The attachment uploaded by the full-stack header test stays in the `hearth_uploads` volume until the orphan-file GC removes it.
- Disk space is tight: 6 GB free on the root partition. Prune images after every rebuild.

### Next step

Phase 9: production deployment on Oracle Cloud with DuckDNS (`docs/plans/phase-9.md`).

## Phase 7 — Camera & screen share ✅ (2026-09-29)

### Built

- **Web:**
  - Camera (720p with simulcast) and screen share (1080p30, `contentHint: 'detail'`, no simulcast, optional tab audio). Each source goes off → starting → on → stopping. A cancelled or blocked picker shows an error, and the browser's own "Stop sharing" is handled.
  - Video stage: a grid plus a focused view. Other people's screen shares focus automatically unless you've pinned a tile, and a pin survives the other source stopping. Your own camera is mirrored.
  - Sidebar badges: `data-camera` and `data-live="screen"` ("LIVE").
  - Screen-share audio follows the sharer's volume slider and is muted by deafen.
  - Privacy fixes from the review:
    - A network reconnect no longer shows the camera or screen as off while it's still being broadcast. "Ended" now comes from the track itself.
    - A start still pending when you leave or switch rooms is unpublished and its capture stopped.
    - The UI and flags follow what LiveKit actually publishes.
  - One `role="alert"` slot on every page, and the media error clears when you navigate.
- **Server:** the re-sync with LiveKit clears stale camera/screen flags when LiveKit reports no matching track. It only ever clears them, only for the matching connection, and never a flag the client just set.
- **e2e:** 6 video scenarios, with the debug hook reporting received video (`videoWidth`, `framesDecoded`).
- **Screen-capture check before building:** headless Chromium with the CLAUDE.md flags can share its screen. No xvfb or canvas fallback needed.

### Tested (run for real on 2026-09-29)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 671 tests (shared 66, web 258, server 347), run with shared `dist/` deleted.
- `pnpm test:e2e --repeat-each=3` ✅: 126/126 (42 specs × 3), no flakes.
- Full stack through Caddy ✅ and LAN profile through `https://192.168.1.110:8443` ✅. In both, Alice turns on her camera and shares her screen with the real UI buttons, and:
  - Bob decodes both streams (screen 1920 wide, camera 320) and sees 2 tiles;
  - Carol, outside the channel, sees the camera and LIVE badges.
- A fresh review found 0 blockers, 2 major (privacy) and 5 minor issues; all are fixed and tested.

### Known issues / notes

- After an abrupt disconnect (crash or closed tab), the LIVE and camera badges clear only after LiveKit's `departure_timeout` (20 s by default), when `voice:left` arrives. While LiveKit still lists the participant, the re-sync correctly keeps their flags.
- The video grid shows every tile (no cap). Adaptive stream lowers the quality of small tiles, which is fine for 6–8 people.

### Next step

Phase 8: admin, moderation, hardening (`docs/plans/phase-8.md`).

## Phase 6 — Voice via LiveKit + LAN test profile ✅ (2026-09-29)

### Built

- **Server:**
  - Access token (row 29):
    - grants exactly per B.6: mic, camera and screen share, no data channel, no room admin;
    - identity is the user id and the room is `voice_<channelId>`;
    - TTL 600 s, rate-limited.
  - Webhook receiver (row 30):
    - reads the raw body and verifies the signature, accepts only `application/webhook+json` (anything else gets 415);
    - ignores duplicate event ids, stale connections and joins arriving out of order;
    - ignores rooms that aren't in this server's database (the dev and e2e servers share one LiveKit container).
  - Voice state is kept in memory:
    - one voice channel per user, with guards against a fast channel switch kicking the new connection;
    - `voice:state` is zod-validated, and a state sent before the join webhook is remembered;
    - it re-syncs with LiveKit at boot and every `VOICE_RECONCILE_MS`. Webhooks, re-syncs and resets run one at a time, and re-sync adopts connections LiveKit still lists.
  - Deleting a voice channel calls LiveKit's `deleteRoom` before deleting it from the DB.
  - Health reports `livekit` (200 with `degraded` when LiveKit is down).
  - The test reset deletes only this database's rooms.
- **Web:**
  - One LiveKit `Room` for the whole app, with joins cancellable and a switch leaving the old room first.
  - Voice panel (connecting/connected/reconnecting), mute and deafen (undeafen restores the earlier mute state), per-user volume saved locally.
  - Speaking ring: LiveKit's active speakers plus a level meter that reads only LiveKit's track stats (no custom WebRTC).
  - Sidebar lists voice participants, and a "Click to enable audio" button appears when playback is blocked.
  - A debug hook in e2e builds only; it reads the real track state.
- **e2e:** 6 voice scenarios against the real LiveKit container with fake media, checking that received audio bytes keep growing.
- **LAN test profile:**
  - `pnpm lan:up` / `pnpm lan:down`.
  - `docker-compose.lan.yml`, `infra/caddy/Caddyfile.lan` (`tls internal`, `default_sni`, wss on :7443), `infra/livekit/livekit.lan.yaml` (no `node_ip`, so `--node-ip <LAN_IP>` wins).
  - The root certificate is exported to `data/lan/`.
  - A device checklist in `docs/DEPLOY.md`.

### Tested (run for real on 2026-09-29)

- Checks run before building:
  - The LiveKit container reaches the host's :3100 (webhooks to the e2e server).
  - Two fake-media Chromium pages exchange audio through the real container.
- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- `pnpm test` ✅: 627 tests (shared 66, web 219, server 342), run with shared `dist/` deleted. Includes a real-LiveKit-container suite.
- `pnpm test:e2e --repeat-each=3` ✅: 108/108 (36 specs × 3), no flakes.
- Full stack (`docker compose up --build`) ✅:
  - `@smoke` passes, and health shows `livekit: ok`.
  - Two fake-media browsers join voice through Caddy on :8080, audio flows both ways (bytes growing), and both participants are listed.
- **LAN profile** ✅:
  - `pnpm lan:up` issues a certificate for `IP:192.168.1.110`, and LiveKit advertises `nodeIP 192.168.1.110`.
  - Two fake-media browsers join voice through `https://192.168.1.110:8443`, with audio flowing over `192.168.1.110:7882/udp`.
  - `pnpm lan:down` works without `LAN_IP`.
- A fresh review found 0 blockers, 2 major and 8 minor issues, all fixed. Each server fix got a test that fails when the fix is reverted.

### Known issues / notes

- **Pending, needs you:** the manual check with a real second device (phone or laptop on the same Wi-Fi), following `docs/DEPLOY.md` → LAN testing.
- Known race: someone joining in the milliseconds between `deleteRoom` and the DB delete re-creates the room; it closes when it empties.
- Not in Phase 6, moved to Phase 8: the admin "disconnect from voice" feature (row 31), the voice part of deactivating a user, and the e2e test for deleting a voice channel with people in it.

### Next step

Phase 7: camera and screen share (`docs/plans/phase-7.md`).

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
