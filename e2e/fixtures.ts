import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Locator,
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

// ---- Phase 6 voice helpers (CONTRACTS B.4 rows 18, 29, B.5 voice events, B.6a; docs/plans/phase-6.md) ----

/** Bound for anything that goes through LiveKit media (connect, subscribe, bytes, speaking). */
export const VOICE_MEDIA_TIMEOUT = 20_000;

/** Admin creates a voice channel through the API (row 15). */
export async function createVoiceChannel(adminRequest: APIRequestContext, name: string): Promise<Channel> {
  return createChannel(adminRequest, { name, type: 'voice' });
}

/**
 * Sidebar voice channel button (`data-testid="voice-channel"`) whose text is exactly `name`; a
 * leading icon glyph (non-word characters) is tolerated.
 */
export function voiceChannel(page: Page, name: string): Locator {
  return page.getByTestId('voice-channel').filter({ hasText: new RegExp(`^\\W*${escapeRegExp(name)}$`) });
}

/** The voice panel (`data-testid="voice-panel"`); at most one exists at a time. */
export function voicePanel(page: Page): Locator {
  return page.getByTestId('voice-panel');
}

/**
 * `userId`'s sidebar entry (`data-testid="voice-participant"`), wherever it is listed. A user is in
 * at most one voice channel, so this should match 0 or 1 elements.
 */
export function voiceParticipant(page: Page, userId: string): Locator {
  return page.locator(`[data-testid="voice-participant"][data-user-id="${userId}"]`);
}

/**
 * Joins the voice channel `name` by clicking it in the sidebar (loading the app first if the page is
 * blank), then waits for the panel to show that channel with `data-state="connected"`.
 */
export async function joinVoice(page: Page, name: string): Promise<void> {
  if (!page.url().startsWith('http')) {
    await page.goto('/');
    await expectConnected(page);
  }
  await voiceChannel(page, name).click();
  await expect(
    voicePanel(page).and(page.locator('[data-state="connected"]')).filter({ hasText: name }),
  ).toBeVisible({ timeout: VOICE_MEDIA_TIMEOUT });
}

/** Presses **Leave** in the voice panel and waits for the panel to go away. */
export async function leaveVoice(page: Page): Promise<void> {
  await voicePanel(page).getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(voicePanel(page)).toHaveCount(0);
}

/** One remote participant as seen by `window.__hearthDebug.voice()`. */
export interface VoiceDebugRemote {
  /** LiveKit identity = the Hearth user id (B.6). */
  identity: string;
  audioSubscribed: boolean;
  /** inbound-rtp `bytesReceived` of the remote's microphone track (0 when not subscribed). */
  audioBytesReceived: number;
  /** Local playback volume for this remote (per-user volume slider). */
  volume: number;
  /** Whether this remote's audio is muted in local playback. */
  muted: boolean;
  /** This remote's camera and screen-share video publications (Phase 7; empty when none). */
  video: VoiceDebugVideo[];
}

/** LiveKit `Track.Source` of a video publication, as the web reports it (docs/plans/phase-7.md). */
export type VideoSource = 'camera' | 'screen_share';

/** One remote video publication in `remotes[].video` of `window.__hearthDebug.voice()`. */
export interface VoiceDebugVideo {
  source: VideoSource;
  subscribed: boolean;
  /** `videoWidth` of the attached `<video>` element (0 when not attached or no frame yet). */
  videoWidth: number;
  /** inbound-rtp `framesDecoded` from `getReceiverStats()` (0 when not subscribed). */
  framesDecoded: number;
}

/** What this page itself publishes (`local` of `window.__hearthDebug.voice()`, Phase 7). */
export interface VoiceDebugLocal {
  camera: boolean;
  screen: boolean;
}

/** `window.__hearthDebug.voice()` (e2e builds only), normalised: absent ids are `null`. */
export interface VoiceDebug {
  /** LiveKit connection state (`disconnected`, `connecting`, `connected`, `reconnecting`, …). */
  state: string;
  /** `voice_<channelId>` while in a room. */
  roomName: string | null;
  localIdentity: string | null;
  /** Deafened: every remote's audio is muted in local playback (the `RoomAudioRenderer` `muted` prop). */
  playbackMuted: boolean;
  remotes: VoiceDebugRemote[];
  local: VoiceDebugLocal;
}

function isVoiceDebugVideo(value: unknown): value is VoiceDebugVideo {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'source' in value &&
    (value.source === 'camera' || value.source === 'screen_share') &&
    'subscribed' in value &&
    typeof value.subscribed === 'boolean' &&
    'videoWidth' in value &&
    typeof value.videoWidth === 'number' &&
    'framesDecoded' in value &&
    typeof value.framesDecoded === 'number'
  );
}

function isVoiceDebugLocal(value: unknown): value is VoiceDebugLocal {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'camera' in value &&
    typeof value.camera === 'boolean' &&
    'screen' in value &&
    typeof value.screen === 'boolean'
  );
}

function isVoiceDebugRemote(value: unknown): value is VoiceDebugRemote {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'identity' in value &&
    typeof value.identity === 'string' &&
    'audioSubscribed' in value &&
    typeof value.audioSubscribed === 'boolean' &&
    'audioBytesReceived' in value &&
    typeof value.audioBytesReceived === 'number' &&
    'volume' in value &&
    typeof value.volume === 'number' &&
    'muted' in value &&
    typeof value.muted === 'boolean' &&
    // Strict (Phase 7): every remote reports its video publications, possibly none.
    'video' in value &&
    Array.isArray(value.video) &&
    (value.video as unknown[]).every(isVoiceDebugVideo)
  );
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

/**
 * Calls `window.__hearthDebug.voice()` (sync or async) in the page and validates its shape, like
 * `hearthEvents`. Throws if the hook is missing (not an e2e build) or malformed.
 */
export async function voiceDebug(page: Page): Promise<VoiceDebug> {
  const raw: unknown = await page.evaluate(async () => {
    const hook = (globalThis as unknown as { __hearthDebug?: { voice?: unknown } }).__hearthDebug;
    if (typeof hook?.voice !== 'function') return { missing: true };
    const voice = hook.voice as () => unknown;
    return { missing: false, value: await voice() };
  });
  if (typeof raw !== 'object' || raw === null || !('missing' in raw) || raw.missing !== false) {
    throw new Error('window.__hearthDebug.voice is missing (is VITE_E2E=true?)');
  }
  const value = 'value' in raw ? raw.value : undefined;
  const malformed = (): Error =>
    new Error(`window.__hearthDebug.voice() is malformed: ${JSON.stringify(value)}`);
  if (typeof value !== 'object' || value === null) throw malformed();
  if (!('state' in value) || typeof value.state !== 'string') throw malformed();
  const roomName = 'roomName' in value ? value.roomName : undefined;
  const localIdentity = 'localIdentity' in value ? value.localIdentity : undefined;
  if (!optionalString(roomName) || !optionalString(localIdentity)) throw malformed();
  if (!('playbackMuted' in value) || typeof value.playbackMuted !== 'boolean') throw malformed();
  if (!('remotes' in value) || !Array.isArray(value.remotes)) throw malformed();
  const remotes: unknown[] = value.remotes;
  if (!remotes.every(isVoiceDebugRemote)) throw malformed();
  if (!('local' in value) || !isVoiceDebugLocal(value.local)) throw malformed();
  return {
    state: value.state,
    roomName: roomName ?? null,
    localIdentity: localIdentity ?? null,
    playbackMuted: value.playbackMuted,
    remotes,
    local: { camera: value.local.camera, screen: value.local.screen },
  };
}

/** One `voice-participant` entry of the sidebar, read from its data attributes. */
export interface VoiceParticipantView {
  userId: string;
  muted: boolean;
  deafened: boolean;
  /** `data-speaking="true"` (only ever set for people in the viewer's own room). */
  speaking: boolean;
}

/**
 * The `voice-participant`s listed under the voice channel `channelName` in `page`'s sidebar, in
 * display order. "Under" is decided by document order: every participant after this channel's
 * button and before the next `voice-channel` button, so it holds whether the list is nested in the
 * channel's container or rendered as siblings. Poll it with `expect.poll`.
 */
export async function voiceParticipants(page: Page, channelName: string): Promise<VoiceParticipantView[]> {
  const raw: unknown = await voiceChannel(page, channelName).evaluate(
    (button: unknown) => {
      interface El {
        getAttribute(name: string): string | null;
      }
      const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<El> } })
        .document;
      const found: (string | null)[][] = [];
      let inside = false;
      // querySelectorAll returns elements in document order.
      for (const el of doc.querySelectorAll(
        '[data-testid="voice-channel"], [data-testid="voice-participant"]',
      )) {
        if (el === button) {
          inside = true;
        } else if (el.getAttribute('data-testid') === 'voice-channel') {
          if (inside) break;
        } else if (inside) {
          found.push([
            el.getAttribute('data-user-id'),
            el.getAttribute('data-muted'),
            el.getAttribute('data-deafened'),
            el.getAttribute('data-speaking'),
          ]);
        }
      }
      return found;
    },
    undefined,
    { timeout: 10_000 },
  );
  if (!Array.isArray(raw)) throw new Error(`voiceParticipants(${channelName}): unexpected result`);
  const rows: unknown[] = raw;
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error(`voiceParticipants(${channelName}): unexpected row`);
    const cells: unknown[] = row;
    const [userId, muted, deafened, speaking] = cells;
    if (typeof userId !== 'string') {
      throw new Error(`voiceParticipants(${channelName}): a voice-participant has no data-user-id`);
    }
    return { userId, muted: muted === 'true', deafened: deafened === 'true', speaking: speaking === 'true' };
  });
}

/** Sorted user ids listed under `channelName`: a stable value for `expect.poll(...).toEqual([...])`. */
export async function voiceParticipantIds(page: Page, channelName: string): Promise<string[]> {
  return (await voiceParticipants(page, channelName)).map((p) => p.userId).sort();
}

/**
 * Asserts that `page` is receiving `identity`'s audio: subscribed, and `audioBytesReceived` > 0 and
 * strictly increasing between two consecutive polls.
 */
export async function expectHearing(page: Page, identity: string, who = identity): Promise<void> {
  let previous = 0;
  await expect
    .poll(
      async () => {
        const remote = (await voiceDebug(page)).remotes.find((r) => r.identity === identity);
        if (remote === undefined) {
          previous = 0;
          return `no remote ${who}`;
        }
        if (!remote.audioSubscribed) {
          previous = 0;
          return `${who}'s audio not subscribed`;
        }
        const bytes = remote.audioBytesReceived;
        const growing = previous > 0 && bytes > previous;
        previous = bytes;
        return growing ? 'flowing' : `${who}'s audioBytesReceived = ${bytes}`;
      },
      { message: `audio from ${who} is flowing`, timeout: VOICE_MEDIA_TIMEOUT, intervals: [500] },
    )
    .toBe('flowing');
}

// ---- Phase 7 video helpers (CONTRACTS B.6b; docs/plans/phase-7.md "Web UI contract", "Debug hook") ----

/** The main-area video stage (`data-testid="video-stage"`), shown while connected with any video. */
export function videoStage(page: Page): Locator {
  return page.getByTestId('video-stage');
}

/**
 * Video tiles (`data-testid="video-tile"`), optionally narrowed to one publisher (`data-user-id`)
 * and/or one source (`data-source`). The focused tile also carries `data-focused="true"`.
 */
export function videoTiles(page: Page, filter: { userId?: string; source?: VideoSource } = {}): Locator {
  let selector = '[data-testid="video-tile"]';
  if (filter.userId !== undefined) selector += `[data-user-id="${filter.userId}"]`;
  if (filter.source !== undefined) selector += `[data-source="${filter.source}"]`;
  return page.locator(selector);
}

/**
 * Asserts that `page` shows and plays `userId`'s `source` video: exactly one matching tile is
 * visible in the video stage, and the debug hook reports that publication subscribed with
 * `videoWidth > 0` and `framesDecoded` > 0 and strictly increasing between two consecutive polls.
 * Sizes are never asserted exactly: adaptive stream may pick a lower layer.
 */
export async function expectVideo(
  page: Page,
  userId: string,
  source: VideoSource,
  who = userId,
): Promise<void> {
  await expect(videoStage(page)).toBeVisible({ timeout: VOICE_MEDIA_TIMEOUT });
  // Strict locator: a duplicate tile for the same publisher and source fails here.
  await expect(videoTiles(page, { userId, source })).toBeVisible({ timeout: VOICE_MEDIA_TIMEOUT });
  let previous = 0;
  await expect
    .poll(
      async () => {
        const remote = (await voiceDebug(page)).remotes.find((r) => r.identity === userId);
        const video = remote?.video.find((v) => v.source === source);
        let status: string;
        if (remote === undefined) status = `no remote ${who}`;
        else if (video === undefined) status = `no ${source} publication from ${who}`;
        else if (!video.subscribed) status = `${who}'s ${source} not subscribed`;
        else if (video.videoWidth <= 0) status = `${who}'s ${source} videoWidth = ${video.videoWidth}`;
        else {
          const frames = video.framesDecoded;
          const growing = previous > 0 && frames > previous;
          previous = frames;
          return growing ? 'playing' : `${who}'s ${source} framesDecoded = ${frames}`;
        }
        previous = 0;
        return status;
      },
      { message: `${source} video from ${who} is playing`, timeout: VOICE_MEDIA_TIMEOUT, intervals: [500] },
    )
    .toBe('playing');
}

/**
 * Asserts that `page` no longer shows `userId`'s `source` video: no tile, and the debug hook lists no
 * such publication for that remote (a remote that left counts as none).
 */
export async function expectNoVideo(
  page: Page,
  userId: string,
  source: VideoSource,
  who = userId,
): Promise<void> {
  await expect(videoTiles(page, { userId, source })).toHaveCount(0, { timeout: VOICE_MEDIA_TIMEOUT });
  await expect
    .poll(
      async () => {
        const remote = (await voiceDebug(page)).remotes.find((r) => r.identity === userId);
        return remote?.video.some((v) => v.source === source) ?? false;
      },
      { message: `${who}'s ${source} publication is gone`, timeout: VOICE_MEDIA_TIMEOUT },
    )
    .toBe(false);
}

/**
 * Makes every `getDisplayMedia` call in `context` reject with a `NotAllowedError` DOMException, as
 * when the user cancels the picker or the permission is denied. Counts the calls in
 * `window.__getDisplayMediaCalls` (read with `displayMediaCalls`). Call before the page loads the
 * app: it is an init script, applied on every navigation of every page in the context.
 */
export async function forceDisplayMediaReject(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // e2e has no DOM lib: reach the page globals through a typed view of globalThis.
    const g = globalThis as unknown as {
      DOMException: new (message: string, name: string) => Error;
      MediaDevices?: { prototype: object };
      navigator: { mediaDevices?: object };
      __getDisplayMediaCalls?: number;
    };
    g.__getDisplayMediaCalls = 0;
    const getDisplayMedia = (): Promise<never> => {
      g.__getDisplayMediaCalls = (g.__getDisplayMediaCalls ?? 0) + 1;
      return Promise.reject(new g.DOMException('Permission denied', 'NotAllowedError'));
    };
    // The prototype covers every MediaDevices; the instance too, in case something shadowed it.
    for (const target of [g.MediaDevices?.prototype, g.navigator.mediaDevices]) {
      if (target === undefined) continue;
      Object.defineProperty(target, 'getDisplayMedia', {
        value: getDisplayMedia,
        configurable: true,
        writable: true,
      });
    }
  });
}

/** How many times the page called the `getDisplayMedia` installed by `forceDisplayMediaReject`. */
export async function displayMediaCalls(page: Page): Promise<number> {
  const calls = await page.evaluate(
    () => (globalThis as unknown as { __getDisplayMediaCalls?: unknown }).__getDisplayMediaCalls ?? null,
  );
  if (typeof calls !== 'number') throw new Error('forceDisplayMediaReject was not installed');
  return calls;
}
