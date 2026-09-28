import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import type {
  Channel,
  ChannelResponse,
  ChannelType,
  DmChannel,
  DmChannelResponse,
  InviteResponse,
  Message,
  MessageResponse,
  TestResetResponse,
  TestSeedMessagesRequest,
  TestSeedMessagesResponse,
  UserResponse,
} from '@hearth/shared';
import { isFullStack, TEST_TOKEN } from './env.js';

/**
 * Shared Playwright fixtures. Specs import `test` / `expect` from here, never from '@playwright/test'.
 *
 * - `resetDb` (auto, every test, dev-server mode only): `POST /api/__test__/reset` (CONTRACTS B.4
 *   row 39). Truncates the DB, drops sockets and yields `{ adminInviteCode }`. `null` in full-stack
 *   mode, where the server has no test mode.
 * - `adminInviteCode`: the fresh admin invite from `resetDb` (throws in full-stack mode).
 * - `users(['alice', 'bob'])`: the first name registers as admin with `adminInviteCode`; the admin
 *   creates one invite per extra name and each registers with it. All through the API, each user in
 *   their own browser context (own cookie jar) with one open page.
 * - `newPage()`: a page in a fresh, anonymous browser context.
 *
 * Every context created here is closed on teardown. Specs that need test mode call
 * `test.skip(isFullStack, NEEDS_TEST_MODE)`.
 */

/**
 * CSRF header required on every non-GET request (CONTRACTS B.4 "Rules"). Hardcoded rather than
 * imported so e2e has no runtime import of @hearth/shared.
 */
export const CSRF_HEADERS = { 'X-Requested-With': 'hearth' } as const;

export const NEEDS_TEST_MODE = 'needs the server test mode (dev-server mode only)';

export interface ApiResult<T> {
  status: number;
  /** Parsed JSON body; `null` when the body is empty (e.g. 204). */
  body: T;
}

interface RequestOptions {
  headers?: Record<string, string>;
}

/** Minimal JSON API client over any APIRequestContext (the `request` fixture, `page.request`, …). */
export function api(request: APIRequestContext) {
  async function parse<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<ApiResult<T>> {
    const text = await res.text();
    // The caller picks T to match the documented response (CONTRACTS B.4); this is not validated.
    const body = (text === '' ? null : JSON.parse(text)) as T;
    return { status: res.status(), body };
  }

  return {
    async get<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
      return parse<T>(await request.get(path, { headers: { ...CSRF_HEADERS, ...options.headers } }));
    },
    async post<T = unknown>(
      path: string,
      data?: unknown,
      options: RequestOptions = {},
    ): Promise<ApiResult<T>> {
      return parse<T>(
        await request.post(path, {
          headers: { ...CSRF_HEADERS, ...options.headers },
          ...(data === undefined ? {} : { data }),
        }),
      );
    },
    async patch<T = unknown>(
      path: string,
      data?: unknown,
      options: RequestOptions = {},
    ): Promise<ApiResult<T>> {
      return parse<T>(
        await request.patch(path, {
          headers: { ...CSRF_HEADERS, ...options.headers },
          ...(data === undefined ? {} : { data }),
        }),
      );
    },
    async delete<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
      return parse<T>(await request.delete(path, { headers: { ...CSRF_HEADERS, ...options.headers } }));
    },
  };
}

export interface TestUser {
  id: string;
  username: string;
  password: string;
  displayName: string;
  context: BrowserContext;
  /** A page in `context`; not navigated yet. */
  page: Page;
  /** `context.request`: shares the context's cookies, so it is authenticated as this user. */
  request: APIRequestContext;
}

export type UsersFn = <const N extends string>(names: readonly [N, ...N[]]) => Promise<Record<N, TestUser>>;

export function passwordFor(username: string): string {
  return `correct-horse-${username}`;
}

export function displayNameFor(username: string): string {
  return username.charAt(0).toUpperCase() + username.slice(1);
}

interface Fixtures {
  resetDb: TestResetResponse | null;
  adminInviteCode: string;
  users: UsersFn;
  newPage: () => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  resetDb: [
    async ({ playwright }, use) => {
      if (isFullStack) {
        await use(null);
        return;
      }
      // Inherits baseURL from the config, so this goes through the Vite proxy like the app does.
      const request = await playwright.request.newContext();
      try {
        const res = await api(request).post<TestResetResponse>('/api/__test__/reset', undefined, {
          headers: { 'X-Test-Token': TEST_TOKEN },
        });
        expect(res.status, 'POST /api/__test__/reset').toBe(200);
        await use(res.body);
      } finally {
        await request.dispose();
      }
    },
    { auto: true },
  ],

  adminInviteCode: async ({ resetDb }, use) => {
    if (resetDb === null) throw new Error(`adminInviteCode ${NEEDS_TEST_MODE}`);
    await use(resetDb.adminInviteCode);
  },

  newPage: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      // browser.newContext() inherits the config's `use` options (baseURL, permissions, device).
      const context = await browser.newContext();
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },

  users: async ({ browser, adminInviteCode }, use) => {
    const contexts: BrowserContext[] = [];
    let admin: TestUser | undefined;

    async function register(username: string, inviteCode: string): Promise<TestUser> {
      const context = await browser.newContext();
      contexts.push(context);
      const password = passwordFor(username);
      const displayName = displayNameFor(username);
      const res = await api(context.request).post<UserResponse>('/api/auth/register', {
        inviteCode,
        username,
        displayName,
        password,
      });
      expect(res.status, `register ${username}`).toBe(201);
      const page = await context.newPage();
      return {
        id: res.body.user.id,
        username,
        password,
        displayName,
        context,
        page,
        request: context.request,
      };
    }

    async function createInvite(by: TestUser): Promise<string> {
      const res = await api(by.request).post<InviteResponse>('/api/admin/invites', { maxUses: 1 });
      expect(res.status, 'POST /api/admin/invites').toBe(201);
      return res.body.invite.code;
    }

    const users: UsersFn = async (names) => {
      if (new Set(names).size !== names.length) {
        throw new Error(`users(): duplicate names in ${names.join()}`);
      }
      const created: Partial<Record<(typeof names)[number], TestUser>> = {};
      for (const name of names) {
        const user = admin
          ? await register(name, await createInvite(admin))
          : await register(name, adminInviteCode);
        admin ??= user;
        created[name] = user;
      }
      // Every name was assigned in the loop above.
      return created as Record<(typeof names)[number], TestUser>;
    };

    await use(users);
    await Promise.all(contexts.map((context) => context.close()));
  },
});

export { expect };

// ---- Phase 3 chat helpers (CONTRACTS B.4 rows 15, 19, 21, 40; docs/plans/phase-3.md "Web UI contract") ----

/** Escapes a string for literal use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text of a sidebar `channel-link` for `name`: the name, tolerating a leading `#` glyph. */
export function channelLinkText(name: string): RegExp {
  return new RegExp(`^\\s*#?\\s*${escapeRegExp(name)}\\s*$`);
}

/** Sidebar link (`data-testid="channel-link"`: text channels and DMs, never voice) for `name`. */
export function channelLink(page: Page, name: string) {
  return page.getByTestId('channel-link').filter({ hasText: channelLinkText(name) });
}

/** Admin creates a text/voice channel through the API (row 15). */
export async function createChannel(
  adminRequest: APIRequestContext,
  { name, type }: { name: string; type: ChannelType },
): Promise<Channel> {
  const res = await api(adminRequest).post<ChannelResponse>('/api/channels', { name, type });
  expect(res.status, `POST /api/channels (${name})`).toBe(201);
  return res.body.channel;
}

/** Gets or creates the DM between the caller and `userId` (row 19; 201 new, 200 existing). */
export async function openDm(request: APIRequestContext, userId: string): Promise<DmChannel> {
  const res = await api(request).post<DmChannelResponse>('/api/dms', { userId });
  expect([200, 201], 'POST /api/dms').toContain(res.status);
  return res.body.channel;
}

export type SeedMessagesOptions = Omit<TestSeedMessagesRequest, 'prefix'> & { prefix?: string };

/**
 * Inserts `"<prefix> 1".."<prefix> count"` directly (row 40, test mode only): no broadcasts, no
 * rate limit. Any request context works; the endpoint is authorised by the test token.
 */
export async function seedMessages(
  request: APIRequestContext,
  options: SeedMessagesOptions,
): Promise<TestSeedMessagesResponse> {
  const res = await api(request).post<TestSeedMessagesResponse>('/api/__test__/seed-messages', options, {
    headers: { 'X-Test-Token': TEST_TOKEN },
  });
  expect(res.status, 'POST /api/__test__/seed-messages').toBe(200);
  return res.body;
}

/** Sends a message through the API as the request's user (row 21; 10 per 10 s per user). */
export async function sendMessage(
  request: APIRequestContext,
  channelId: string,
  content: string,
): Promise<Message> {
  const res = await api(request).post<MessageResponse>(`/api/channels/${channelId}/messages`, { content });
  expect(res.status, `POST /api/channels/${channelId}/messages`).toBe(201);
  return res.body.message;
}

/** Waits until the header's `socket-status` reads `connected`. */
export async function expectConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('socket-status')).toHaveText('connected');
}

/**
 * Opens a text channel or DM by clicking its sidebar `channel-link` and waits for `channel-title`
 * (`#name` for a channel, the display name for a DM). Loads the app first if the page is blank.
 */
export async function gotoChannel(page: Page, name: string): Promise<void> {
  if (!page.url().startsWith('http')) await page.goto('/');
  await channelLink(page, name).click();
  await expect(page.getByTestId('channel-title')).toHaveText(new RegExp(`^#?${escapeRegExp(name)}$`));
}

export interface SocketSwitch {
  /**
   * Emulates losing the network: `context.setOffline(true)`, closes every open `/socket.io/`
   * WebSocket and refuses new ones until `goOnline()`.
   */
  goOffline(): Promise<void>;
  /** Restores the network; the app's own reconnect logic takes it from there. */
  goOnline(): Promise<void>;
}

/**
 * Routes the context's Socket.IO WebSockets through Playwright so a test can cut them. Needed
 * because Chromium's `setOffline(true)` stalls an already-open WebSocket instead of closing it, and
 * engine.io-client skips its `offline` listener on `localhost`, so the app would never notice.
 * Messages pass through untouched (the real socket is opened by the page, keeping Origin/cookies).
 * Call before the page loads the app.
 */
export async function socketSwitch(context: BrowserContext): Promise<SocketSwitch> {
  let offline = false;
  const open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();

  await context.routeWebSocket(/\/socket\.io\//, (ws) => {
    if (offline) {
      void ws.close();
      return;
    }
    const pair = { page: ws, server: ws.connectToServer() };
    open.add(pair);
    ws.onClose(() => open.delete(pair));
  });

  return {
    async goOffline() {
      offline = true;
      await context.setOffline(true);
      const pairs = [...open];
      open.clear();
      await Promise.all(pairs.flatMap(({ page, server }) => [page.close(), server.close()]));
    },
    async goOnline() {
      offline = false;
      await context.setOffline(false);
    },
  };
}

/** One entry of the e2e-build debug hook `window.__hearthEvents` (server→client socket events). */
export interface HearthEvent {
  event: string;
  /** The channel the event is about, or `null` for events without one (e.g. `channels:reordered`). */
  channelId: string | null;
}

function isHearthEvent(value: unknown): value is HearthEvent {
  if (typeof value !== 'object' || value === null) return false;
  if (!('event' in value) || typeof value.event !== 'string') return false;
  return 'channelId' in value && (value.channelId === null || typeof value.channelId === 'string');
}

/** Reads `window.__hearthEvents` (present only when the web app is built with `VITE_E2E=true`). */
export async function hearthEvents(page: Page): Promise<HearthEvent[]> {
  // e2e has no DOM lib, so the page global is reached through globalThis and checked on this side.
  const raw = await page.evaluate(
    () => (globalThis as unknown as { __hearthEvents?: unknown }).__hearthEvents ?? null,
  );
  if (!Array.isArray(raw)) throw new Error('window.__hearthEvents is missing (is VITE_E2E=true?)');
  const events: unknown[] = raw;
  if (!events.every(isHearthEvent)) {
    throw new Error(`window.__hearthEvents has malformed entries: ${JSON.stringify(events)}`);
  }
  return events;
}
