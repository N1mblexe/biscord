# Phase 8 plan — Admin, moderation, hardening

Status: **approved 2026-09-29**. Adjustments: GC already done in Phase 5 (review only); the reset-code page folds into `/admin/users` (update the Phase 2 e2e spec); CSP also covers the LAN profile (`wss://<LAN_IP>:7443`); fix the presence dot overlapping small avatars (Phase 5 note).. Source: PLAN.md §2 (roles and lifecycle), §5 Phase 8, §6 (limits and security); CONTRACTS.md B.4 rows 18, 31, 35–38, B.7, B.8.
Starts only after Phase 7 is committed. It relies on the LiveKit room service (Phase 6), attachment storage (Phase 5) and presence (Phase 4).

## Goal

Admins can run the group safely, and the app is hardened before it goes on the internet:

- promote and demote users; deactivate and reactivate accounts, with a full teardown;
- kick someone out of voice;
- delete a voice channel while people are in it;
- every lifecycle rule in B.7 is enforced, idempotent and tested;
- security headers, a reviewed set of rate limits, and scheduled garbage collection (GC) of orphaned uploads.

## In scope

| Area                 | Contract                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role change          | row 35 `PATCH /admin/users/:id {role}` → `user:updated`; `LAST_ADMIN` guard                                                                        |
| Deactivate           | row 36 → the B.7 teardown (DB tx → `session:revoked` + disconnect → LiveKit `removeParticipant` → `user:updated` + `presence`); `LAST_ADMIN` guard |
| Reactivate           | row 37 → `user:updated`; `USER_LIMIT` when the account cap is reached                                                                              |
| Reset code           | row 38 (exists since Phase 2; this phase adds it to the users UI)                                                                                  |
| Voice disconnect     | row 31 `POST /voice/:channelId/participants/:userId/disconnect` (admin)                                                                            |
| Delete voice channel | row 18 with occupants: `deleteRoom` first (a 404 counts as success), then the DB delete, then `channel:deleted`                                    |
| Hardening            | Caddy security headers + CSP, rate-limit review, GC schedule, Caddy running as non-root                                                            |

## Contract clarifications (CONTRACTS.md, in the same commit)

1. **Last-admin guard:** "the last active admin" is counted inside the same transaction under an advisory lock, so two admins demoting each other at the same time can't leave zero admins. The guard covers both demotion (row 35) and deactivation (row 36), whether the target is yourself or someone else.
2. **Deactivate is idempotent:** deactivating an already-deactivated user gives 204 with no events. Reactivating an active user gives 204 with no events.
3. **Reactivation:** restores the account, but not its sessions, so the user has to log in again. The username stays reserved while the account is deactivated (unchanged from §2).
4. **Voice disconnect (row 31):** a user who isn't in that room gives `NOT_FOUND`; LiveKit being unreachable gives `LIVEKIT_UNAVAILABLE`. The server also tells the client why via a new server→client event `voice:kicked {channelId, reason: 'admin'|'channel_deleted'|'deactivated'}` sent to `user:<id>`, so the UI can show a notice instead of a silent drop. **Contract addition: add it to B.5 and to the shared socket maps.**
5. **Deleted-user rendering:** clients render `PublicUser.deactivated === true` as "Deleted user" with a neutral avatar, both in message authors and in DM titles. A DM with a deactivated user becomes read-only (already enforced on the server in Phase 3).
6. **GC schedule:**
   - The GC runs once at startup and then every hour.
   - It deletes unattached attachments older than 24 h, tmp files older than 1 h, and files on disk with no DB row. The disk-versus-DB reconcile runs once a day.
   - Each run takes a Postgres advisory lock, so only one instance does the work.

## Key decisions

- **One lifecycle service** (`services/lifecycle.ts`) owns every multi-system flow: `deactivateUser`, `reactivateUser`, `changeRole`, `deleteVoiceChannel` and `disconnectFromVoice`.
  - Each flow runs the B.7 steps in order.
  - Every step is idempotent, so a crash between steps is fixed by retrying the same request.
  - A LiveKit failure after the DB commit is logged and retried by the 60 s voice reconcile loop from Phase 6. The HTTP call still returns 204, because the DB is the source of truth.
- **Reuse, don't rebuild:**
  - Session revocation uses `deleteUserSessions` and `Realtime.revokeSessions` (Phase 2).
  - Presence emits go through the Phase 4 presence module, which gets a `forceOffline(userId)` helper.
  - LiveKit calls go through the Phase 6 `livekit/client.ts`.
- **Admin users UI** (`/admin/users`): a table of every user with role, status and last seen. Actions: **Make admin** / **Remove admin**, **Deactivate** / **Reactivate** (with a confirm dialog), and **Generate reset code**. The existing `/admin/users/reset` page folds into it.
- **Voice moderation UI:** admins see a **Disconnect** item in a voice participant's menu, in the sidebar list.
- **Security headers (Caddy, in both local and prod configs):**
  - CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss://lk.<domain> ws://localhost:7880; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
    - Tailwind 4 emits a static stylesheet, so no inline scripts are needed.
    - `'unsafe-inline'` for styles covers React's `style` props.
    - `connect-src` is templated per environment.
  - Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`, `Cross-Origin-Opener-Policy: same-origin`, and HSTS in prod only.
- **Caddy as non-root:** both images run as a non-root user with `setcap cap_net_bind_service` on the binary. The local stack listens on :8080 and never needed root. Closes the PROGRESS.md known issue.
- **Rate-limit review:** a table of every limit (login, register, reset, invite check, send, upload, reactions, typing, voice token) with a Vitest test for each 429. Add the missing ones: voice token 30/min/user, reactions 30/10 s/user, and admin mutations 60/min/admin.
- **Bundle size:** the web bundle is about 510 kB. Split the admin pages and the LiveKit voice UI into lazy route chunks (React Router `lazy`). Target an initial chunk under 350 kB.

## Web UI contract (for parallel e2e work)

| Where             | Contract                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/admin/users`    | Rows `data-testid="user-row"` with `data-username`, containing `user-role` (`admin`/`member`) and `user-status` (`active`/`deactivated`). Buttons **Make admin**, **Remove admin**, **Deactivate**, **Reactivate**, **Generate reset code** (the code appears in `reset-code`). Deactivate opens `role="dialog"` **Deactivate user** with a **Deactivate** button. |
| Errors            | `LAST_ADMIN` → alert "You can't remove the last admin." `USER_LIMIT` → alert "The account limit has been reached."                                                                                                                                                                                                                                                 |
| Deleted users     | Authors and DM titles show "Deleted user". The composer in a read-only DM is disabled, labelled "This conversation is read-only."                                                                                                                                                                                                                                  |
| Voice kick notice | `data-testid="app-notice"`: "You were disconnected from voice by an admin." / "This voice channel was deleted." / (for deactivation, the Phase 2 `session:revoked` login redirect handles it).                                                                                                                                                                     |
| Voice participant | Admins get a button **Disconnect** in each `voice-participant` menu.                                                                                                                                                                                                                                                                                               |

## Execution (tech lead + subagents)

1. **Lead:**
   - Add contract clarifications 1–6 plus the `voice:kicked` event to CONTRACTS.md and the shared socket schemas.
   - Add the non-root Caddy change and the CSP to `infra/caddy/Caddyfile`.
2. **Parallel:**
   - **server agent:** the lifecycle service and routes 31, 35–37, the voice-channel delete path, rate-limit additions, the GC scheduler, and Vitest.
   - **web agent:** the admin users page, "Deleted user" rendering, voice kick notices, the **Disconnect** action, lazy route chunks, and unit tests.
   - **e2e agent:** the specs below.
3. **Fresh security-focused reviewer** → fix-up agent → the lead runs acceptance (dev-server e2e 3×; full stack with a curl check of the CSP and headers) → PROGRESS.md → commit `phase 8: …`.

## Acceptance tests

**Vitest (server, real DB; LiveKit room service stubbed at the client boundary):**

- **Last admin:** the only admin demoting themselves, or deactivating themselves → 409 `LAST_ADMIN`. Two admins demoting each other concurrently → exactly one succeeds.
- **Deactivate teardown order:** sessions are deleted, `session:revoked` is received before the socket closes, `removeParticipant` is called, and `user:updated` plus `presence:false` are broadcast. A second call is a no-op.
- **Deactivated user:** login gives `INVALID_CREDENTIALS`; a DM with them is read-only (send → 403); they show as `deactivated: true` in `/users` and bootstrap.
- **Reactivate:** `USER_LIMIT` at the cap; otherwise 204, and login works again.
- **Voice disconnect:** a non-member → `NOT_FOUND`; a non-admin → 403; LiveKit down → 503 `LIVEKIT_UNAVAILABLE`.
- **Voice channel delete:**
  - `deleteRoom` is called before the DB delete; a 404 from LiveKit counts as success.
  - LiveKit down → 503 with the DB untouched.
  - `voice:kicked {reason:'channel_deleted'}` goes to the occupants.
- **GC:** old unattached rows and files are removed, recent ones kept; stale tmp files removed; orphan files on disk removed; the lock stops two runs overlapping.
- **Rate limits:** every limit in the review table returns 429 with `retryAfterMs`.

**Playwright (dev-server mode, real LiveKit):**

1. **Deactivate a user in voice:** alice (admin) and bob are in the voice channel.
   - alice deactivates bob in `/admin/users`.
   - bob's page lands on `/login?reason=deactivated`, and his voice participant disappears for alice.
   - bob's login fails.
   - alice sees bob's old messages authored by "Deleted user", and their DM is read-only.
2. **Last admin:** alice (the only admin) clicks **Remove admin** on herself → the `LAST_ADMIN` alert appears and her role is unchanged.
3. **Delete a voice channel with 2 occupants:** alice and bob are in `Lounge`; the admin deletes it → both are disconnected and see "This voice channel was deleted." The channel disappears from the sidebar.
4. **Admin voice disconnect:** the admin clicks **Disconnect** on bob → bob leaves voice and sees the notice.
5. **Reactivate:** at the cap → the `USER_LIMIT` alert; below the cap → bob can log in again.
6. **Headers:** in full-stack mode, `GET /` carries the CSP and the other headers listed above, and a same-origin WebSocket and a LiveKit connection still work under the CSP (the voice smoke test passes).

## Dependencies

None.

## Risks

1. **Partial teardown across DB, sockets and LiveKit.** One ordered, idempotent service plus the reconcile loop; order and idempotency are covered by tests.
2. **The CSP breaking LiveKit or the app.** `connect-src` and `media-src` are templated per environment. A full-stack e2e voice smoke test runs under the real CSP before the phase is committed.
3. **Concurrent admin actions.** An advisory lock guards the last-admin check and the reactivate cap, with tests that run both at once.
