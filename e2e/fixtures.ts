import { test as base, expect } from '@playwright/test';

/**
 * Shared Playwright fixtures. Specs import `test` / `expect` from here, never from '@playwright/test'.
 *
 * Phase 1: a pass-through of Playwright's base `test` so specs already use this entry point.
 *
 * Planned (Phase 2+, once POST /api/__test__/reset exists — CONTRACTS.md B.4 endpoint 39):
 *
 * - `resetDb` (auto, per test): `POST /api/__test__/reset` with header `X-Test-Token: TEST_TOKEN`
 *   (see ./env.ts). The server truncates every table except migrations, clears presence/voice
 *   memory, deletes LiveKit rooms, disconnects sockets, and returns an admin invite code, which
 *   this fixture exposes to the test.
 *
 * - `users(['alice', 'bob', ...])`: registers the first user with the admin invite through the
 *   API (`request.newContext`); that user creates invites and the others register. Each user
 *   gets an isolated `browser.newContext({ storageState })` (own cookies) and a `Page`, all in
 *   the one browser process with fake media devices. Contexts are closed on teardown.
 */
export const test = base;

export { expect };
