import { InviteCheckResponse, SESSION_COOKIE, UserResponse } from '@hearth/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invites, sessions, users } from '../src/db/schema.js';
import { sha256Hex } from '../src/lib/crypto.js';
import * as passwords from '../src/services/passwords.js';
import { makeApp, testEnv } from './helpers/app.js';
import {
  api,
  expectError,
  getInvite,
  insertInvite,
  insertUser,
  login,
  PASSWORD,
  registerViaApi,
  sessionCookie,
  sessionCount,
} from './helpers/auth.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

// Pass-through spy on hashPassword, to prove a bad invite is rejected before any argon2 work.
vi.mock('../src/services/passwords.js', async (importOriginal) => {
  const actual = await importOriginal<typeof passwords>();
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});
const hashSpy = vi.mocked(passwords.hashPassword);

let app: FastifyInstance;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

describe('POST /api/auth/register', () => {
  it('creates the user, sets the session cookie, and /me works', async () => {
    const invite = await insertInvite();
    const res = await registerViaApi(app, 'alice', invite.code);
    expect(res.statusCode, res.payload).toBe(201);

    const { user } = UserResponse.parse(res.json());
    expect(user).toMatchObject({
      username: 'alice',
      displayName: 'ALICE',
      role: 'member',
      avatarUrl: null,
      deactivated: false,
    });

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 3600 });
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Only the sha256 of the token is stored.
    const [stored] = await testDb().db.select().from(sessions);
    expect(stored?.tokenHash).toBe(sha256Hex(cookie?.value ?? ''));

    const me = await api(app, 'GET', '/api/me', { cookie: sessionCookie(res) });
    expect(me.statusCode).toBe(200);
    expect(UserResponse.parse(me.json()).user).toEqual(user);
    expect((await getInvite(invite.id)).uses).toBe(1);
  });

  it('grants the invite role (admin invites make admins) and accepts a lower-case code', async () => {
    const invite = await insertInvite({ grantsRole: 'admin' });
    const res = await registerViaApi(app, 'root', invite.code.toLowerCase());
    expect(res.statusCode, res.payload).toBe(201);
    expect(UserResponse.parse(res.json()).user.role).toBe('admin');
  });

  it('sets Secure on the cookie when COOKIE_SECURE=true', async () => {
    const secureApp = makeApp({ env: testEnv({ COOKIE_SECURE: 'true' }) });
    try {
      const invite = await insertInvite();
      const res = await registerViaApi(secureApp, 'alice', invite.code);
      expect(res.statusCode).toBe(201);
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
    } finally {
      await secureApp.close();
    }
  });

  describe('INVITE_INVALID', () => {
    it('a used-up invite', async () => {
      const invite = await insertInvite({ maxUses: 1 });
      expect((await registerViaApi(app, 'alice', invite.code)).statusCode).toBe(201);
      expectError(await registerViaApi(app, 'bob', invite.code), 400, 'INVITE_INVALID');
      expect((await getInvite(invite.id)).uses).toBe(1);
    });

    it('an expired invite', async () => {
      const invite = await insertInvite();
      await testDb()
        .db.update(invites)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(invites.id, invite.id));
      expectError(await registerViaApi(app, 'alice', invite.code), 400, 'INVITE_INVALID');
      expect((await getInvite(invite.id)).uses).toBe(0);
    });

    it('a revoked invite', async () => {
      const invite = await insertInvite();
      await testDb().db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, invite.id));
      expectError(await registerViaApi(app, 'alice', invite.code), 400, 'INVITE_INVALID');
    });

    it('an unknown code', async () => {
      expectError(await registerViaApi(app, 'alice', 'NOPENOPENOPENOPE'), 400, 'INVITE_INVALID');
      expect(await testDb().db.select().from(users)).toHaveLength(0);
    });
  });

  it('rejects a bad invite with a cheap read before hashing the password', async () => {
    const used = await insertInvite({ maxUses: 1 });
    await testDb().db.update(invites).set({ uses: 1 }).where(eq(invites.id, used.id));
    hashSpy.mockClear();

    expectError(await registerViaApi(app, 'alice', 'NOPENOPENOPENOPE'), 400, 'INVITE_INVALID');
    expectError(await registerViaApi(app, 'alice', used.code), 400, 'INVITE_INVALID');
    expect(hashSpy).not.toHaveBeenCalled();

    // A good invite hashes exactly once.
    const good = await insertInvite();
    expect((await registerViaApi(app, 'alice', good.code)).statusCode).toBe(201);
    expect(hashSpy).toHaveBeenCalledTimes(1);
  });

  it('two concurrent registrations on a maxUses=1 invite: exactly one succeeds', async () => {
    const invite = await insertInvite({ maxUses: 1 });
    const results = await Promise.all([
      registerViaApi(app, 'alice', invite.code),
      registerViaApi(app, 'bob', invite.code),
    ]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 400]);
    const loser = results.find((r) => r.statusCode === 400);
    if (loser === undefined) throw new Error('expected one failure');
    expectError(loser, 400, 'INVITE_INVALID');
    expect(await testDb().db.select().from(users)).toHaveLength(1);
    expect((await getInvite(invite.id)).uses).toBe(1);
  });

  it('USER_LIMIT at the cap (deactivated users do not count), and the invite use is not consumed', async () => {
    const capped = makeApp({ env: testEnv({ MAX_USERS: '2' }) });
    try {
      await insertUser('one');
      await insertUser('gone', { deactivated: true });
      const invite = await insertInvite({ maxUses: 5 });
      expect((await registerViaApi(capped, 'two', invite.code)).statusCode).toBe(201);
      expectError(await registerViaApi(capped, 'three', invite.code), 403, 'USER_LIMIT');
      expect((await getInvite(invite.id)).uses).toBe(1);
    } finally {
      await capped.close();
    }
  });

  it('USERNAME_TAKEN rolls the invite use back', async () => {
    await insertUser('alice');
    const invite = await insertInvite({ maxUses: 1 });
    expectError(await registerViaApi(app, 'alice', invite.code), 409, 'USERNAME_TAKEN');
    expect((await getInvite(invite.id)).uses).toBe(0);
    // The invite is still usable.
    expect((await registerViaApi(app, 'bob', invite.code)).statusCode).toBe(201);
  });

  it('rejects an invalid body with VALIDATION', async () => {
    const invite = await insertInvite();
    const res = await api(app, 'POST', '/api/auth/register', {
      body: { inviteCode: invite.code, username: 'Bad Name', displayName: 'x', password: 'short' },
    });
    const body = expectError(res, 400, 'VALIDATION');
    expect(body.error.details).toMatchObject({ fieldErrors: { username: expect.any(Array) as unknown } });
    expect((await getInvite(invite.id)).uses).toBe(0);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in, sets a new session cookie, returns Me', async () => {
    const user = await insertUser('alice');
    const res = await api(app, 'POST', '/api/auth/login', {
      body: { username: 'alice', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(UserResponse.parse(res.json()).user.id).toBe(user.id);
    const me = await api(app, 'GET', '/api/me', { cookie: sessionCookie(res) });
    expect(me.statusCode).toBe(200);
  });

  it('accepts the username in any case', async () => {
    await insertUser('alice');
    await login(app, 'Alice');
  });

  it('a wrong password and an unknown user both give INVALID_CREDENTIALS', async () => {
    await insertUser('alice');
    const wrong = expectError(
      await api(app, 'POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong password' } }),
      401,
      'INVALID_CREDENTIALS',
    );
    const unknown = expectError(
      await api(app, 'POST', '/api/auth/login', { body: { username: 'nobody', password: PASSWORD } }),
      401,
      'INVALID_CREDENTIALS',
    );
    expect(unknown.error.message).toBe(wrong.error.message);
  });

  it('a deactivated user gives INVALID_CREDENTIALS', async () => {
    await insertUser('gone', { deactivated: true });
    expectError(
      await api(app, 'POST', '/api/auth/login', { body: { username: 'gone', password: PASSWORD } }),
      401,
      'INVALID_CREDENTIALS',
    );
  });

  it('malformed credentials give INVALID_CREDENTIALS, not VALIDATION', async () => {
    expectError(
      await api(app, 'POST', '/api/auth/login', { body: { username: 'NOT VALID!', password: 'x' } }),
      401,
      'INVALID_CREDENTIALS',
    );
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session, clears the cookie, and the old cookie no longer works', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    const other = await login(app, 'alice');

    const res = await api(app, 'POST', '/api/auth/logout', { cookie });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect(cleared?.expires?.getTime()).toBeLessThanOrEqual(Date.now());

    expectError(await api(app, 'GET', '/api/me', { cookie }), 401, 'UNAUTHENTICATED');
    expect((await api(app, 'GET', '/api/me', { cookie: other })).statusCode).toBe(200);
    expect(await sessionCount(user.id)).toBe(1);
  });

  it('anonymous → 401', async () => {
    expectError(await api(app, 'POST', '/api/auth/logout'), 401, 'UNAUTHENTICATED');
  });
});

describe('GET /api/invites/:code/check', () => {
  it('reports validity without consuming the invite', async () => {
    const invite = await insertInvite();
    const ok = await api(app, 'GET', `/api/invites/${invite.code}/check`);
    expect(ok.statusCode).toBe(200);
    expect(InviteCheckResponse.parse(ok.json())).toEqual({ valid: true });
    expect((await getInvite(invite.id)).uses).toBe(0);

    await testDb().db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, invite.id));
    expect((await api(app, 'GET', `/api/invites/${invite.code}/check`)).json()).toEqual({ valid: false });
    expect((await api(app, 'GET', '/api/invites/UNKNOWNCODE/check')).json()).toEqual({ valid: false });
  });
});

describe('cross-cutting', () => {
  it('CSRF header is enforced on every new state-changing route', async () => {
    const admin = await insertUser('admin', { role: 'admin' });
    const cookie = await login(app, 'admin');
    const routes: ['POST' | 'PATCH' | 'DELETE', string][] = [
      ['POST', '/api/auth/register'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/reset-password'],
      ['PATCH', '/api/me'],
      ['POST', '/api/me/password'],
      ['POST', '/api/admin/invites'],
      ['DELETE', '/api/admin/invites/00000000-0000-4000-8000-000000000000'],
      ['POST', `/api/admin/users/${admin.id}/reset-code`],
    ];
    for (const [method, url] of routes) {
      const res = await api(app, method, url, { cookie, body: {}, noCsrf: true });
      expectError(res, 403, 'FORBIDDEN');
    }
    // Nothing was changed: the session still works.
    expect((await api(app, 'GET', '/api/me', { cookie })).statusCode).toBe(200);
  });

  it('anonymous requests to user routes → 401', async () => {
    for (const [method, url] of [
      ['GET', '/api/me'],
      ['PATCH', '/api/me'],
      ['POST', '/api/me/password'],
      ['GET', '/api/users'],
    ] as const) {
      expectError(await api(app, method, url, { body: {} }), 401, 'UNAUTHENTICATED');
    }
  });

  it('a garbage cookie → 401 and the stale cookie is cleared', async () => {
    const res = await api(app, 'GET', '/api/me', { cookie: `${SESSION_COOKIE}=garbage` });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });
});
