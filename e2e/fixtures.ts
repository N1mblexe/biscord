import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import type {
  Attachment,
  AttachmentResponse,
  Channel,
  ChannelResponse,
  ChannelType,
  DmChannel,
  DmChannelResponse,
  InviteResponse,
  Me,
  Message,
  MessageResponse,
  TestResetResponse,
  TestSeedMessagesRequest,
  TestSeedMessagesResponse,
  UserResponse,
} from '@hearth/shared';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isFullStack, TEST_TOKEN, UPLOAD_DIR_E2E } from './env.js';

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

async function parse<T>(res: APIResponse): Promise<ApiResult<T>> {
  const text = await res.text();
  // The caller picks T to match the documented response (CONTRACTS B.4); this is not validated.
  const body = (text === '' ? null : JSON.parse(text)) as T;
  return { status: res.status(), body };
}

/** Minimal JSON API client over any APIRequestContext (the `request` fixture, `page.request`, …). */
export function api(request: APIRequestContext) {
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
    async put<T = unknown>(
      path: string,
      data?: unknown,
      options: RequestOptions = {},
    ): Promise<ApiResult<T>> {
      return parse<T>(
        await request.put(path, {
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

/**
 * Sidebar link (`data-testid="channel-link"`: text channels and DMs, never voice) whose
 * `channel-link-name` child is exactly `name` (a leading `#` glyph tolerated), so `dev` never
 * matches `dev2` and a `mention-badge` count doesn't get in the way.
 */
export function channelLink(page: Page, name: string) {
  const exact = new RegExp(`^#?${escapeRegExp(name)}$`);
  return page
    .getByTestId('channel-link')
    .filter({ has: page.getByTestId('channel-link-name').filter({ hasText: exact }) });
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

/**
 * Sends a message through the API as the request's user (row 21; 10 per 10 s per user), optionally
 * claiming the caller's unattached uploads (`attachmentIds`, ≤ 10).
 */
export async function sendMessage(
  request: APIRequestContext,
  channelId: string,
  content: string,
  attachmentIds?: readonly string[],
): Promise<Message> {
  const body = attachmentIds === undefined ? { content } : { content, attachmentIds };
  const res = await api(request).post<MessageResponse>(`/api/channels/${channelId}/messages`, body);
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

// ---- Phase 4 realtime helpers (CONTRACTS B.4 rows 24–26, B.5a; docs/plans/phase-4.md "Web UI contract") ----

/** A second page (tab) in the user's own context: same cookies, its own socket. */
export async function openSecondTab(user: TestUser): Promise<Page> {
  return user.context.newPage();
}

/** Adds `emoji` to a message as the request's user (row 24; 204, idempotent). */
export async function react(request: APIRequestContext, messageId: string, emoji: string): Promise<void> {
  const res = await api(request).put(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  expect(res.status, `PUT /api/messages/${messageId}/reactions/${emoji}`).toBe(204);
}

/** One `new Notification(title, { body })` call recorded by the `stubNotifications` stub. */
export interface RecordedNotification {
  title: string;
  body: string | null;
}

function isRecordedNotification(value: unknown): value is RecordedNotification {
  if (typeof value !== 'object' || value === null) return false;
  if (!('title' in value) || typeof value.title !== 'string') return false;
  return 'body' in value && (value.body === null || typeof value.body === 'string');
}

/**
 * Runs in the page (serialised by `addInitScript`, so it must be self-contained). e2e has no DOM
 * lib, so page globals are reached through `globalThis`.
 */
function installNotificationStub(): void {
  interface Recorded {
    title: string;
    body: string | null;
  }
  const recorded: Recorded[] = [];

  class FakeNotification extends EventTarget {
    static readonly permission = 'granted';
    static requestPermission(callback?: (permission: string) => void): Promise<string> {
      callback?.('granted');
      return Promise.resolve('granted');
    }

    readonly title: string;
    readonly body: string;
    onclick: unknown = null;
    onclose: unknown = null;
    onerror: unknown = null;
    onshow: unknown = null;

    constructor(title: string, options?: { body?: string }) {
      super();
      this.title = title;
      this.body = options?.body ?? '';
      recorded.push({ title, body: options?.body ?? null });
    }

    close(): void {
      // Nothing to close: no real notification is shown.
    }
  }

  Object.defineProperty(globalThis, '__notifications', { configurable: true, value: recorded });
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: FakeNotification,
  });
}

/**
 * Replaces `window.Notification` with a recording stub (`permission` is `'granted'`,
 * `requestPermission()` resolves `'granted'`). Install it on the context (or page) before the app
 * loads; it applies to every later navigation. Read the calls with `notifications(page)`.
 */
export async function stubNotifications(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript(installNotificationStub);
}

/** The notifications the stub recorded in this page's current document, in order. */
export async function notifications(page: Page): Promise<RecordedNotification[]> {
  const raw = await page.evaluate(
    () => (globalThis as unknown as { __notifications?: unknown }).__notifications ?? null,
  );
  if (!Array.isArray(raw))
    throw new Error('window.__notifications is missing (call stubNotifications first)');
  const entries: unknown[] = raw;
  if (!entries.every(isRecordedNotification)) {
    throw new Error(`window.__notifications has malformed entries: ${JSON.stringify(entries)}`);
  }
  return entries;
}

/**
 * Pretends the tab is hidden (or visible again): overrides `document.visibilityState`,
 * `document.hidden` and `document.hasFocus()`, then dispatches `visibilitychange`. Headless Chromium
 * keeps every page visible, so this is the only way to reach the app's hidden-tab code paths.
 */
export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  const state = await page.evaluate((isHidden) => {
    interface Doc {
      readonly visibilityState: string;
      dispatchEvent(event: Event): boolean;
    }
    const doc = (globalThis as unknown as { document: Doc }).document;
    Object.defineProperty(doc, 'visibilityState', {
      configurable: true,
      get: () => (isHidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(doc, 'hidden', { configurable: true, get: () => isHidden });
    Object.defineProperty(doc, 'hasFocus', { configurable: true, writable: true, value: () => !isHidden });
    doc.dispatchEvent(new Event('visibilitychange'));
    return doc.visibilityState;
  }, hidden);
  expect(state).toBe(hidden ? 'hidden' : 'visible');
}

// ---- Phase 5 upload helpers (CONTRACTS B.4 rows 10, 11, 14, 27, 28, B.7a; docs/plans/phase-5.md) ----
// No binary fixtures are committed: every file is generated here, in memory.

/** An in-memory file: accepted by `setInputFiles` and as a Playwright `multipart` part. */
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** A valid 1×1 RGBA PNG (IHDR, IDAT, IEND with correct CRCs). */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A valid 1×1 GIF89a (sniffed as image/gif: inline as an attachment, rejected as an avatar). */
const TINY_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** A 1×1 PNG; renders with `naturalWidth` 1 and sniffs as `image/png`. */
export function tinyPng(name = 'pixel.png'): FilePayload {
  return { name, mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_BASE64, 'base64') };
}

/** A 1×1 GIF; sniffs as `image/gif`. */
export function tinyGif(name = 'pixel.gif'): FilePayload {
  return { name, mimeType: 'image/gif', buffer: Buffer.from(TINY_GIF_BASE64, 'base64') };
}

/** A minimal one-object PDF; sniffs as `application/pdf` (served as an `attachment`). */
export function tinyPdf(name = 'report.pdf'): FilePayload {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [] /Count 0 >>',
    'endobj',
    'trailer',
    '<< /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n');
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'latin1') };
}

/** A UTF-8 text file with a client-declared type (the server ignores it and sniffs, B.7a). */
export function textFile(name: string, content: string, mimeType = 'text/plain'): FilePayload {
  return { name, mimeType, buffer: Buffer.from(content, 'utf8') };
}

/**
 * `LIMITS.uploadMaxBytes` (25 MiB). Mirrored here because e2e may only `import type` from
 * `@hearth/shared` (see e2e/tsconfig.json).
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Exactly `UPLOAD_MAX_BYTES` of `0x61`, in memory: the largest upload the server accepts. */
export function maxSizeFile(name = 'max.bin'): FilePayload {
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(UPLOAD_MAX_BYTES, 0x61) };
}

/** 26 MB of zeros: 1 MB over the 25 MB upload cap (LIMITS.uploadMaxBytes). Never written to disk. */
export function oversizeFile(name = 'huge.bin'): FilePayload {
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(26 * 1024 * 1024) };
}

/**
 * `POST /api/attachments` (row 27) with the single multipart part `file`, as the request's user.
 * Returns the raw result so callers can assert errors (413, 429, …); see `uploadAttachmentOk`.
 */
export async function uploadAttachment<T = AttachmentResponse>(
  request: APIRequestContext,
  file: FilePayload,
): Promise<ApiResult<T>> {
  return parse<T>(await request.post('/api/attachments', { headers: CSRF_HEADERS, multipart: { file } }));
}

/** Uploads `file` (row 27), expects 201 and returns the (still unattached) attachment. */
export async function uploadAttachmentOk(request: APIRequestContext, file: FilePayload): Promise<Attachment> {
  const res = await uploadAttachment(request, file);
  expect(res.status, `POST /api/attachments (${file.name})`).toBe(201);
  return res.body.attachment;
}

/** `PUT /api/me/avatar` (row 10) with `file` as the request's user; expects 200 and returns `Me`. */
export async function setAvatar(request: APIRequestContext, png: FilePayload): Promise<Me> {
  const res = await parse<UserResponse>(
    await request.put('/api/me/avatar', { headers: CSRF_HEADERS, multipart: { file: png } }),
  );
  expect(res.status, 'PUT /api/me/avatar').toBe(200);
  return res.body.user;
}

/**
 * Finds the stored copy of `content` under the e2e server's `UPLOAD_DIR` (attachments and avatars,
 * not `tmp/`) and returns its path relative to `UPLOAD_DIR`, or `null`. Use content unique to the
 * test; the test reset empties `UPLOAD_DIR`. Dev-server mode only.
 */
export async function findStoredFile(content: Buffer): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(UPLOAD_DIR_E2E, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relative(UPLOAD_DIR_E2E, join(entry.parentPath, entry.name));
    if (rel.startsWith('tmp/')) continue;
    // The file may be unlinked between readdir and readFile (post-commit unlink, GC).
    const bytes = await readFile(join(UPLOAD_DIR_E2E, rel)).catch(() => null);
    if (bytes !== null && bytes.equals(content)) return rel;
  }
  return null;
}
