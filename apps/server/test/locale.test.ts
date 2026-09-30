import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BootstrapResponse, UserResponse, UsersResponse, type Me } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { makeApp, testEnv } from './helpers/app.js';
import {
  api,
  expectError,
  insertInvite,
  insertUser,
  login,
  PASSWORD,
  sessionCookie,
} from './helpers/auth.js';
import { connectRecording, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

/** CONTRACTS B.11: the per-account UI language (`users.locale`, `Me.locale`). */

let app: FastifyInstance;
let baseUrl: string;
const opened: RecordingClient[] = [];

beforeEach(async () => {
  await truncateAll();
  app = makeApp({ env: testEnv() });
  baseUrl = await listen(app);
});
afterEach(async () => {
  for (const s of opened.splice(0)) s.client.disconnect();
  await app.close();
});
afterAll(closeTestDb);

function me(res: LightMyRequestResponse): Me {
  expect(res.statusCode, res.payload).toBe(200);
  return UserResponse.parse(res.json()).user;
}

async function storedLocale(id: string): Promise<string | undefined> {
  const [row] = await testDb().db.select({ locale: users.locale }).from(users).where(eq(users.id, id));
  return row?.locale;
}

async function connect(cookie: string): Promise<RecordingClient> {
  const s = await connectRecording(baseUrl, cookie, { ignore: ['presence', 'readstate:updated'] });
  opened.push(s);
  return s;
}

describe('users.locale column', () => {
  it('the migration adds the column with default en to existing rows, plus the check', async () => {
    const sqlText = await readFile(path.join(MIGRATIONS_FOLDER, '0002_user_locale.sql'), 'utf8');
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const client = await testDb().pool.connect();
    try {
      await client.query('begin');
      // Back to the pre-migration shape, with a user row that predates the column.
      await client.query('alter table users drop constraint users_locale_ck');
      await client.query('alter table users drop column locale');
      await client.query(
        `insert into users (username, display_name, password_hash) values ('old', 'Old', 'x')`,
      );
      for (const statement of statements) await client.query(statement);
      const { rows } = await client.query<{ locale: string }>(
        `select locale from users where username = 'old'`,
      );
      expect(rows).toEqual([{ locale: 'en' }]);
      await client.query('savepoint bad');
      await expect(
        client.query(`update users set locale = 'de' where username = 'old'`),
      ).rejects.toMatchObject({ code: '23514', constraint: 'users_locale_ck' });
      await client.query('rollback to savepoint bad');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('a new user defaults to en; the check rejects an unsupported value', async () => {
    const alice = await insertUser('alice');
    expect(alice.locale).toBe('en');
    await expect(
      testDb().pool.query(`update users set locale = 'de' where id = $1`, [alice.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'users_locale_ck' });
  });
});

describe('POST /api/auth/register', () => {
  const body = (username: string, inviteCode: string, extra: Record<string, unknown> = {}) => ({
    inviteCode,
    username,
    displayName: username,
    password: PASSWORD,
    ...extra,
  });

  it('stores the given locale and returns it on Me', async () => {
    const invite = await insertInvite();
    const res = await api(app, 'POST', '/api/auth/register', {
      body: body('alice', invite.code, { locale: 'tr' }),
    });
    expect(res.statusCode, res.payload).toBe(201);
    const user = UserResponse.parse(res.json()).user;
    expect(user.locale).toBe('tr');
    expect(await storedLocale(user.id)).toBe('tr');
    expect(me(await api(app, 'GET', '/api/me', { cookie: sessionCookie(res) })).locale).toBe('tr');
  });

  it('defaults to en without a locale', async () => {
    const invite = await insertInvite();
    const res = await api(app, 'POST', '/api/auth/register', { body: body('alice', invite.code) });
    expect(res.statusCode, res.payload).toBe(201);
    expect(UserResponse.parse(res.json()).user.locale).toBe('en');
  });

  it('an unsupported locale → 400 VALIDATION, no user', async () => {
    const invite = await insertInvite();
    expectError(
      await api(app, 'POST', '/api/auth/register', { body: body('alice', invite.code, { locale: 'de' }) }),
      400,
      'VALIDATION',
    );
    expect(await testDb().db.select().from(users)).toEqual([]);
  });
});

describe('PATCH /api/me', () => {
  let alice: Awaited<ReturnType<typeof insertUser>>;
  let aliceCookie: string;
  let bob: RecordingClient;

  beforeEach(async () => {
    alice = await insertUser('alice');
    await insertUser('bob');
    aliceCookie = await login(app, 'alice');
    bob = await connect(await login(app, 'bob'));
  });

  const patch = (body: unknown) => api(app, 'PATCH', '/api/me', { cookie: aliceCookie, body });

  it('{locale} → 200 with the new locale and no user:updated', async () => {
    const updated = me(await patch({ locale: 'tr' }));
    expect(updated).toMatchObject({ id: alice.id, displayName: 'alice', locale: 'tr' });
    expect(await storedLocale(alice.id)).toBe('tr');
    expect(me(await api(app, 'GET', '/api/me', { cookie: aliceCookie })).locale).toBe('tr');

    // A later displayName change is the first user:updated bob sees: the locale change emitted nothing.
    me(await patch({ displayName: 'Alice!' }));
    await bob.waitFor('user:updated');
    expect(bob.of('user:updated')).toHaveLength(1);
    expect(bob.of('user:updated')[0]).toMatchObject({ user: { displayName: 'Alice!' } });
  });

  it('{displayName} still broadcasts user:updated (PublicUser, no locale)', async () => {
    await patch({ locale: 'tr' });
    const updated = me(await patch({ displayName: 'Alice!' }));
    expect(updated).toMatchObject({ displayName: 'Alice!', locale: 'tr' });
    await bob.waitFor('user:updated');
    const [event] = bob.of('user:updated') as { user: Record<string, unknown> }[];
    expect(event?.user).toMatchObject({ id: alice.id, displayName: 'Alice!' });
    expect(event?.user).not.toHaveProperty('locale');
    expect(event?.user).not.toHaveProperty('createdAt');
  });

  it('{displayName, locale} updates both and broadcasts once, without the locale', async () => {
    const updated = me(await patch({ displayName: 'Ali', locale: 'tr' }));
    expect(updated).toMatchObject({ displayName: 'Ali', locale: 'tr' });
    await bob.waitFor('user:updated');
    expect(bob.of('user:updated')).toHaveLength(1);
    expect(JSON.stringify(bob.events)).not.toContain('"locale"');
  });

  it('{} → 400 VALIDATION', async () => {
    expectError(await patch({}), 400, 'VALIDATION');
  });

  it('an unsupported locale → 400 VALIDATION, nothing changes', async () => {
    expectError(await patch({ locale: 'de' }), 400, 'VALIDATION');
    expectError(await patch({ displayName: 'Alice!', locale: 'de' }), 400, 'VALIDATION');
    expect(me(await api(app, 'GET', '/api/me', { cookie: aliceCookie }))).toMatchObject({
      displayName: 'alice',
      locale: 'en',
    });
  });
});

describe('where users are serialized', () => {
  it('bootstrap me carries the locale; PublicUser lists never do', async () => {
    const alice = await insertUser('alice');
    await insertUser('bob');
    const cookie = await login(app, 'alice');
    await api(app, 'PATCH', '/api/me', { cookie, body: { locale: 'tr' } });

    const bootRes = await api(app, 'GET', '/api/bootstrap', { cookie });
    expect(bootRes.statusCode, bootRes.payload).toBe(200);
    const boot = bootRes.json<{ me: unknown; users: unknown[] }>();
    expect(BootstrapResponse.parse(boot).me).toMatchObject({ id: alice.id, locale: 'tr' });
    for (const user of boot.users) expect(user).not.toHaveProperty('locale');

    const listRes = await api(app, 'GET', '/api/users', { cookie });
    expect(listRes.statusCode, listRes.payload).toBe(200);
    const list = listRes.json<{ users: unknown[] }>();
    expect(UsersResponse.parse(list).users).toHaveLength(2);
    for (const user of list.users) expect(user).not.toHaveProperty('locale');
  });
});
