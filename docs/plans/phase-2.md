# Phase 2 plan — Accounts & auth

Status: **approved 2026-09-28**. Source: PLAN.md §5 Phase 2 and CONTRACTS.md B.4/B.5/B.7.

## Goal

People can get in, stay in, and be kicked out cleanly:

- Bootstrap the first admin.
- Invite-only registration.
- Login and logout with DB-backed sessions.
- Profile and password changes.
- Admin invites and reset codes.
- An authenticated Socket.IO connection that the server can revoke.

## In scope (CONTRACTS B.4 rows)

| Group  | Rows                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Auth   | 2 register · 3 login · 4 logout · 5 reset-password · 6 invite check                                                          |
| Me     | 7 GET /me · 8 PATCH /me · 9 POST /me/password                                                                                |
| Admin  | 32–34 invites list/create/revoke · 38 reset-code · 13 GET /users (moved up from Phase 3: the reset-code UI needs user ids)   |
| Test   | 39 `POST /api/__test__/reset` (test mode only; truncates the DB, drops sockets, returns a fresh admin invite)                |
| Socket | handshake auth (cookie + Origin), rooms `all` / `user:<id>` / `session:<id>`, `session:revoked`, `user:updated` on PATCH /me |

**Deferred:**

| Deferred item                                                      | Moves to |
| ------------------------------------------------------------------ | -------- |
| Avatars (rows 10–11)                                               | Phase 5  |
| `/bootstrap`                                                       | Phase 3  |
| Role change, deactivate, reactivate (35–37) and the admin users UI | Phase 8  |
| Presence                                                           | Phase 4  |

## Key decisions

- **Sessions:**
  - 32 random bytes (base64url) go in cookie `hearth_session`, with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when `COOKIE_SECURE` is set.
  - The DB stores only the sha256 hex of the token.
  - Sliding expiry: `lastSeenAt` and `expiresAt` are bumped at most once per hour.
  - Expired sessions are deleted lazily when they're used.
- **Passwords:** `@node-rs/argon2` argon2id with the library defaults. Login always runs one verify, against a dummy hash when the user is unknown, so response timing doesn't reveal which usernames exist.
- **Registration is one transaction:**
  1. `pg_advisory_xact_lock(HEARTH_REGISTER)`.
  2. Count active users: at or above `MAX_USERS` → `USER_LIMIT`.
  3. Conditional `UPDATE invites SET uses = uses + 1 WHERE code = $1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses RETURNING grants_role`. Zero rows → `INVITE_INVALID`.
  4. Insert the user. A unique violation → `USERNAME_TAKEN`, and the rollback also undoes the invite use.
  5. Create the session.
- **Codes:**
  - Invite: 16 characters of Crockford base32.
  - Reset code: 12 characters, stored hashed, single use, valid 24 h. Issuing a new code invalidates the user's older unused codes.
- **Revocation:** revoking a session emits `session:revoked`, then `disconnectSockets(true)` on the room.

  | Action          | Sessions revoked                    | Reason             |
  | --------------- | ----------------------------------- | ------------------ |
  | Logout          | that session                        | `logout`           |
  | Change password | every other session (current stays) | `password_changed` |
  | Reset password  | all of the user's sessions          | `password_reset`   |

- **Socket.IO:** attached in `buildApp` via `new Server(app.server, …)`, and closed in `onClose`. No `fastify-socket.io` dependency. Every client→server event goes through a shared zod-validation wrapper (no client events yet besides the existing contract ones).
- **Rate limits:** `@fastify/rate-limit` with `global: false`. Login, reset-password and the invite check get 10/min/IP. 429 uses the shared `RATE_LIMITED` body with `retryAfterMs`.
- **New env `TRUST_PROXY`** (bool, default `false`; compose and prod set `true`) so rate limits see the real client IP behind Caddy or the Vite proxy. **Contract change:** added to CONTRACTS B.8 and `.env.example`.
- **Test reset (row 39):**
  - Registered only when `HEARTH_TEST_MODE=true`.
  - Checks `X-Test-Token` with `timingSafeEqual`.
  - Truncates every app table with `RESTART IDENTITY CASCADE` and disconnects every socket.
  - Returns `{ adminInviteCode }` for a new admin invite.
- **Bootstrap CLI:** `pnpm --filter @hearth/server bootstrap` (in Docker: `docker compose exec server node dist/cli/bootstrap.js`). It refuses if an active admin already exists (`--force` overrides) and prints the code plus `<APP_ORIGIN>/register?invite=<code>`.
- **Web, React Router 8 in data mode:**
  - `createBrowserRouter` comes from `react-router` and `RouterProvider` from `react-router/dom`. No framework mode and no `react-router-dom`.
  - Guards are route `loader`s that call `queryClient.ensureQueryData(meQuery)`:
    - a 401 does `redirect('/login?next=…')`;
    - a non-admin on `/admin/*` does `redirect('/')`;
    - on the public pages, an already logged-in user is redirected to `/`.
  - TanStack Query holds server state, and mutations invalidate `['me']`.
  - zustand isn't needed yet (it arrives in Phase 3).
- **API client** (`apps/web/src/api/client.ts`):
  - Always sends `X-Requested-With: hearth` and `credentials: 'same-origin'`.
  - Validates every response with its shared zod schema.
  - Throws `ApiError { status, code, message, details }` parsed from `ApiErrorBody`.
- **Socket client:** connects after login, from the protected layout.
  - `session:revoked`, or a `connect_error` with `UNAUTHENTICATED`, clears the query cache and navigates to `/login?reason=<reason>`.
  - Status is shown in the header.

## Web routes and UI contract (for parallel e2e work)

| Route                       | Access | Content                                                                                                                                                                                                |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`                    | public | labels **Username**, **Password**; button **Log in**; the Phase 1 title + server status (`app-title`, `server-status`) stay on this page; `?reason=` shows a notice (`data-testid="auth-notice"`)      |
| `/register?invite=`         | public | labels **Invite code** (prefilled), **Username**, **Display name**, **Password**; button **Create account**                                                                                            |
| `/reset-password`           | public | labels **Username**, **Reset code**, **New password**; button **Set new password**                                                                                                                     |
| `/` (layout)                | user   | header: display name (`data-testid="current-user"`), socket status (`data-testid="socket-status"` = `connected` / `disconnected`), button **Log out**, link **Settings**, link **Admin** (admins only) |
| `/` index                   | user   | `data-testid="home-welcome"` "Welcome, {displayName}" (channels arrive in Phase 3)                                                                                                                     |
| `/settings`                 | user   | profile form (**Display name**, button **Save profile**); password form (**Current password**, **New password**, button **Change password**)                                                           |
| `/admin/invites`            | admin  | form (**Max uses**, **Expires in (hours)**, button **Create invite**); table rows `data-testid="invite-row"` showing code (`data-testid="invite-code"`), uses, expiry, and a **Revoke** button         |
| `/admin/users/reset` (tiny) | admin  | `<select>` labelled **User** (option text = username, value = user id), button **Generate reset code**, then the code in `data-testid="reset-code"`                                                    |

Form errors show in `role="alert"` with the server's message. Field errors come from `VALIDATION` details.

## Execution (tech lead + subagents)

1. **Lead:**
   - Add deps and run one `pnpm install`:
     - server: `@fastify/cookie`, `@fastify/rate-limit`, `@node-rs/argon2`, `socket.io`, plus `socket.io-client` as a dev dep for tests
     - web: `react-router@8.4.0`, `@tanstack/react-query`, `socket.io-client`
   - Add `TRUST_PROXY` to CONTRACTS, `.env.example` and compose.
2. **Parallel:**
   - **server agent** (`apps/server/**`): services, plugins, routes, socket, CLI, Vitest.
   - **web agent** (`apps/web/**`): router, pages, API client, socket client, unit tests.
   - **e2e agent** (`e2e/**`): fixtures `resetDb` (auto) and `users([...])`, the specs below, and the smoke test updated for `/login`.
3. **Fresh reviewer**, then the lead runs acceptance, updates PROGRESS.md and commits `phase 2: …`.

## Acceptance tests

**Vitest (server, real `hearth_unit`):**

- Register happy path, then a cookie is set and `/me` works.
- Invites: used, expired (`expires_at` moved into the past with SQL), revoked and unknown codes all give `INVITE_INVALID`.
- Two concurrent registrations on a `maxUses=1` invite: exactly one succeeds.
- `USER_LIMIT` at the cap.
- `USERNAME_TAKEN` rolls the invite use back.
- Login: a wrong password and an unknown user both give `INVALID_CREDENTIALS`.
- Sliding expiry is bumped; an expired session gives 401.
- A reset code is single-use, expires, and revokes every session.
- Changing the password revokes the other sessions.
- The 11th login in a minute gives 429 with `retryAfterMs`.
- Test reset: 404 when test mode is off, 403 with a wrong token.
- Sockets:
  - refused without a cookie, with a bad cookie, or with a foreign `Origin`;
  - accepted with a valid session;
  - receives `session:revoked` and gets disconnected on logout.

**Playwright (dev-server mode; the `users` fixture gives each user its own browser context):**

1. The admin registers via the reset invite, sees `home-welcome` and `socket-status=connected`, logs out, then logs back in.
2. The admin creates an invite in the UI, a second context registers bob with it, and bob has no Admin link. Bob's `GET /api/admin/invites` gives 403.
3. Reusing that used invite and using a revoked invite both show the `INVITE_INVALID` message. (**Deviation from PLAN.md:** the expired case is covered in Vitest, because e2e can't move time.)
4. An anonymous `GET /api/me` gives 401 and `/` redirects to `/login`.
5. The same user in two contexts: changing the password in A sends B to `/login?reason=password_changed`, while A stays logged in.
6. The admin generates a reset code for bob, bob resets his password on `/reset-password` and logs in with the new one.

**Full stack:** `docker compose up --build`, then `E2E_BASE_URL=http://localhost:8080 pnpm test:e2e --grep @smoke`. The auth specs need test mode, so they only run in dev-server mode.

## Risks

1. **Cookies, the ws proxy and Origin through Vite and Caddy.** Covered by the `socket-status` e2e test in both modes and by the Origin Vitest test.
2. **Registration races on the invite and the user cap.** Covered by the advisory lock and a concurrent test.
3. **React Router 8 is newer than my training data.** I stick to the data-mode primitives documented in the v7→v8 guide (`createBrowserRouter`, loaders, `redirect`, `Outlet`), and the typecheck and e2e tests will catch API drift.
