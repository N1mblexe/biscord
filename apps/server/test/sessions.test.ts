import { SESSION_COOKIE, UserResponse, UsersResponse } from '@hearth/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessions, users } from '../src/db/schema.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login, PASSWORD, sessionCount } from './helpers/auth.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

const DAY_MS = 24 * 3600 * 1000;

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

async function onlySession(userId: string): Promise<typeof sessions.$inferSelect> {
  const rows = await testDb().db.select().from(sessions).where(eq(sessions.userId, userId));
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no session');
  return row;
}

describe('sessions', () => {
  it('sliding expiry is bumped when the last bump is over an hour old', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    await testDb()
      .db.update(sessions)
      .set({ lastSeenAt: sql`now() - interval '2 hours'`, expiresAt: sql`now() + interval '1 day'` })
      .where(eq(sessions.userId, user.id));

    const before = Date.now();
    expect((await api(app, 'GET', '/api/me', { cookie })).statusCode).toBe(200);
    const bumped = await onlySession(user.id);
    expect(bumped.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(bumped.expiresAt.getTime()).toBeGreaterThan(before + 29 * DAY_MS);
  });

  it('a bumped request re-sends the session cookie (same token, full Max-Age)', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    await testDb()
      .db.update(sessions)
      .set({ lastSeenAt: sql`now() - interval '61 minutes'` })
      .where(eq(sessions.userId, user.id));

    const res = await api(app, 'GET', '/api/me', { cookie });
    expect(res.statusCode).toBe(200);
    const sent = res.cookies.filter((c) => c.name === SESSION_COOKIE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      value: cookie.slice(`${SESSION_COOKIE}=`.length),
      maxAge: 30 * 24 * 3600,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });
  });

  it('a request that does not bump sends no Set-Cookie', async () => {
    await insertUser('alice');
    const cookie = await login(app, 'alice');
    const res = await api(app, 'GET', '/api/me', { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('logout on a bumped request still clears the cookie', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    await testDb()
      .db.update(sessions)
      .set({ lastSeenAt: sql`now() - interval '2 hours'` })
      .where(eq(sessions.userId, user.id));

    const res = await api(app, 'POST', '/api/auth/logout', { cookie });
    expect(res.statusCode).toBe(204);
    const sent = res.cookies.filter((c) => c.name === SESSION_COOKIE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.value).toBe('');
  });

  it('is not bumped again within the hour', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    await testDb()
      .db.update(sessions)
      .set({ lastSeenAt: sql`now() - interval '10 minutes'`, expiresAt: sql`now() + interval '1 day'` })
      .where(eq(sessions.userId, user.id));
    const before = await onlySession(user.id);

    expect((await api(app, 'GET', '/api/me', { cookie })).statusCode).toBe(200);
    const after = await onlySession(user.id);
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('an expired session gives 401 and is deleted lazily', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    await testDb()
      .db.update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.userId, user.id));

    const res = await api(app, 'GET', '/api/me', { cookie });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect(await sessionCount(user.id)).toBe(0);
  });

  it('a session of a deactivated user gives 401', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    await testDb().db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, user.id));
    expectError(await api(app, 'GET', '/api/me', { cookie }), 401, 'UNAUTHENTICATED');
  });
});

describe('/api/me', () => {
  it('GET returns Me', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    const res = await api(app, 'GET', '/api/me', { cookie });
    expect(UserResponse.parse(res.json()).user).toEqual({
      id: user.id,
      username: 'alice',
      displayName: 'alice',
      avatarUrl: null,
      role: 'member',
      deactivated: false,
      createdAt: user.createdAt.toISOString(),
    });
  });

  it('PATCH updates the display name (trimmed)', async () => {
    await insertUser('alice');
    const cookie = await login(app, 'alice');
    const res = await api(app, 'PATCH', '/api/me', { cookie, body: { displayName: '  Alice A.  ' } });
    expect(res.statusCode).toBe(200);
    expect(UserResponse.parse(res.json()).user.displayName).toBe('Alice A.');
    expect(UserResponse.parse((await api(app, 'GET', '/api/me', { cookie })).json()).user.displayName).toBe(
      'Alice A.',
    );
  });

  it('PATCH rejects an empty or overlong display name', async () => {
    await insertUser('alice');
    const cookie = await login(app, 'alice');
    expectError(
      await api(app, 'PATCH', '/api/me', { cookie, body: { displayName: '   ' } }),
      400,
      'VALIDATION',
    );
    expectError(
      await api(app, 'PATCH', '/api/me', { cookie, body: { displayName: 'x'.repeat(33) } }),
      400,
      'VALIDATION',
    );
  });
});

describe('POST /api/me/password', () => {
  it('changes the password and revokes every other session; the current one stays', async () => {
    const user = await insertUser('alice');
    const current = await login(app, 'alice');
    const other = await login(app, 'alice');

    const res = await api(app, 'POST', '/api/me/password', {
      cookie: current,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
    });
    expect(res.statusCode).toBe(204);

    expect((await api(app, 'GET', '/api/me', { cookie: current })).statusCode).toBe(200);
    expectError(await api(app, 'GET', '/api/me', { cookie: other }), 401, 'UNAUTHENTICATED');
    expect(await sessionCount(user.id)).toBe(1);

    expectError(
      await api(app, 'POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } }),
      401,
      'INVALID_CREDENTIALS',
    );
    await login(app, 'alice', 'a brand new password');
  });

  it('a wrong current password gives INVALID_CREDENTIALS and changes nothing', async () => {
    const user = await insertUser('alice');
    const current = await login(app, 'alice');
    await login(app, 'alice');
    expectError(
      await api(app, 'POST', '/api/me/password', {
        cookie: current,
        body: { currentPassword: 'not my password', newPassword: 'a brand new password' },
      }),
      401,
      'INVALID_CREDENTIALS',
    );
    expect(await sessionCount(user.id)).toBe(2);
    await login(app, 'alice');
  });

  it('a too-short new password gives VALIDATION', async () => {
    await insertUser('alice');
    const cookie = await login(app, 'alice');
    expectError(
      await api(app, 'POST', '/api/me/password', {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: 'short' },
      }),
      400,
      'VALIDATION',
    );
  });
});

describe('GET /api/users', () => {
  it('lists every user, deactivated included, as PublicUser', async () => {
    await insertUser('bob');
    await insertUser('alice');
    await insertUser('gone', { deactivated: true });
    const cookie = await login(app, 'bob');
    const res = await api(app, 'GET', '/api/users', { cookie });
    expect(res.statusCode).toBe(200);
    const { users: list } = UsersResponse.parse(res.json());
    expect(list.map((u) => [u.username, u.deactivated])).toEqual([
      ['alice', false],
      ['bob', false],
      ['gone', true],
    ]);
    expect(list[0]).not.toHaveProperty('createdAt');
  });
});
