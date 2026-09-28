import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { InviteResponse, TestResetResponse, UserResponse } from '@hearth/shared';
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
