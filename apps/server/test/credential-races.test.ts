import { ResetCodeResponse } from '@hearth/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from '../src/db/client.js';
import { passwordResetCodes, sessions } from '../src/db/schema.js';
import type { UserRow } from '../src/db/types.js';
import { sha256Hex } from '../src/lib/crypto.js';
import * as passwords from '../src/services/passwords.js';
import { USERS_LOCK_KEY } from '../src/services/users.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login, PASSWORD, sessionCount } from './helpers/auth.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { unitDatabaseUrl } from './helpers/env.js';
import { waitUntil } from './helpers/wait.js';

// Pass-through spy on verifyPassword, so a test can hold a request between its argon2 verify and the
// transaction that acts on it (the race window of CONTRACTS B.9 rule 3).
vi.mock('../src/services/passwords.js', async (importOriginal) => {
  const actual = await importOriginal<typeof passwords>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
const verifySpy = vi.mocked(passwords.verifyPassword);
const { verifyPassword: realVerify } = await vi.importActual<typeof passwords>(
  '../src/services/passwords.js',
);

/** Makes the next verifyPassword call pause after verifying, until `release()`. */
function gateNextVerify(): { reached: Promise<void>; release: () => void } {
  let onReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (onReached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  verifySpy.mockImplementationOnce(async (hash, password) => {
    const ok = await realVerify(hash, password);
    onReached();
    await gate;
    return ok;
  });
  return { reached, release };
}

const NEW_PASSWORD = 'reset password 123';

// The app gets its own pool: the tests hold connections of the shared one while requests run.
let appDb: DbHandle;
let app: FastifyInstance;
let bob: UserRow;
let adminCookie: string;

beforeEach(async () => {
  await truncateAll();
  appDb = createDb(unitDatabaseUrl(), { max: 10 });
  app = makeApp({ db: appDb.db });
  await app.ready();
  await insertUser('admin', { role: 'admin' });
  bob = await insertUser('bob');
  adminCookie = await login(app, 'admin');
});
afterEach(async () => {
  verifySpy.mockReset();
  verifySpy.mockImplementation(realVerify);
  await app.close();
  await appDb.pool.end();
});
afterAll(closeTestDb);

const loginRes = (username: string, password: string) =>
  api(app, 'POST', '/api/auth/login', { body: { username, password } });
const resetRes = (code: string, newPassword = NEW_PASSWORD) =>
  api(app, 'POST', '/api/auth/reset-password', { body: { username: 'bob', code, newPassword } });
const adminPost = (path: string) =>
  api(app, 'POST', `/api/admin/users/${bob.id}/${path}`, { cookie: adminCookie });

async function issueCode(): Promise<string> {
  const res = await adminPost('reset-code');
  expect(res.statusCode, res.payload).toBe(200);
  return ResetCodeResponse.parse(res.json()).code;
}

async function unusedCodeCount(userId: string): Promise<number> {
  const rows = await testDb()
    .db.select({ id: passwordResetCodes.id })
    .from(passwordResetCodes)
    .where(and(eq(passwordResetCodes.userId, userId), isNull(passwordResetCodes.usedAt)));
  return rows.length;
}

/** Backends of the app waiting on a heavyweight lock (a row lock or an advisory lock). */
async function lockWaiters(): Promise<number> {
  const { rows } = await testDb().pool.query<{ n: string }>(
    "select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return Number(rows[0]?.n);
}

describe('login vs concurrent credential changes (B.9 rule 3)', () => {
  it('a deactivation while the login verifies → no session, not even after reactivation', async () => {
    const { reached, release } = gateNextVerify();
    const pending = loginRes('bob', PASSWORD);
    await reached;
    expect((await adminPost('deactivate')).statusCode).toBe(204);
    release();
    expectError(await pending, 401, 'INVALID_CREDENTIALS');
    expect(await sessionCount(bob.id)).toBe(0);

    expect((await adminPost('reactivate')).statusCode).toBe(204);
    expect(await sessionCount(bob.id)).toBe(0);
    // A fresh login works as usual.
    await login(app, 'bob');
  });

  it('a password reset while an old-password login verifies → the old password yields no session', async () => {
    const code = await issueCode();
    const { reached, release } = gateNextVerify();
    const pending = loginRes('bob', PASSWORD);
    await reached;
    expect((await resetRes(code)).statusCode).toBe(204);
    release();
    const res = await pending;
    expectError(res, 401, 'INVALID_CREDENTIALS');
    expect(res.cookies.find((c) => c.name === 'hearth_session')).toBeUndefined();
    expect(await sessionCount(bob.id)).toBe(0);
    await login(app, 'bob', NEW_PASSWORD);
  });

  it('a password change while an old-password login verifies → the old password yields no session', async () => {
    const bobCookie = await login(app, 'bob');
    const { reached, release } = gateNextVerify();
    const pending = loginRes('bob', PASSWORD);
    await reached;
    const change = await api(app, 'POST', '/api/me/password', {
      cookie: bobCookie,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(change.statusCode, change.payload).toBe(204);
    release();
    expectError(await pending, 401, 'INVALID_CREDENTIALS');
    expect(await sessionCount(bob.id)).toBe(1); // only the changer's own session
  });
});

describe('change-password (B.9 rule 3)', () => {
  it('two concurrent changes: the one whose session the other revoked → 401 and changes nothing', async () => {
    const cookieA = await login(app, 'bob');
    const cookieB = await login(app, 'bob');
    const change = (cookie: string, newPassword: string) =>
      api(app, 'POST', '/api/me/password', { cookie, body: { currentPassword: PASSWORD, newPassword } });

    const { reached, release } = gateNextVerify();
    const pendingB = change(cookieB, 'password from B 1');
    await reached;
    const resA = await change(cookieA, 'password from A 1');
    expect(resA.statusCode, resA.payload).toBe(204);
    release();
    expectError(await pendingB, 401, 'UNAUTHENTICATED');

    // A's password is the one in force; B's never was.
    await login(app, 'bob', 'password from A 1');
    expectError(await loginRes('bob', 'password from B 1'), 401, 'INVALID_CREDENTIALS');
    expect((await api(app, 'GET', '/api/me', { cookie: cookieA })).statusCode).toBe(200);
    expectError(await api(app, 'GET', '/api/me', { cookie: cookieB }), 401, 'UNAUTHENTICATED');
  });

  it('two concurrent changes from the same session: the second one (stale hash) → INVALID_CREDENTIALS', async () => {
    const cookie = await login(app, 'bob');
    const change = (newPassword: string) =>
      api(app, 'POST', '/api/me/password', { cookie, body: { currentPassword: PASSWORD, newPassword } });
    const { reached, release } = gateNextVerify();
    const pending = change('second password 1');
    await reached;
    expect((await change('first password 1')).statusCode).toBe(204);
    release();
    expectError(await pending, 401, 'INVALID_CREDENTIALS');
    await login(app, 'bob', 'first password 1');
  });

  it('voids the unused reset codes', async () => {
    const code = await issueCode();
    const cookie = await login(app, 'bob');
    const res = await api(app, 'POST', '/api/me/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: 'changed password 1' },
    });
    expect(res.statusCode, res.payload).toBe(204);
    expect(await unusedCodeCount(bob.id)).toBe(0);
    expectError(await resetRes(code), 401, 'INVALID_CREDENTIALS');
    await login(app, 'bob', 'changed password 1');
  });
});

describe('reset codes under concurrency', () => {
  it('a successful reset voids the other unused codes', async () => {
    const code = await issueCode();
    // A second unused code (as a race before the fix could leave behind).
    await testDb()
      .db.insert(passwordResetCodes)
      .values({
        userId: bob.id,
        codeHash: sha256Hex('ZZZZZZZZZZZZ'),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    expect((await resetRes(code)).statusCode).toBe(204);
    expect(await unusedCodeCount(bob.id)).toBe(0);
    expectError(await resetRes('ZZZZZZZZZZZZ', 'another password 1'), 401, 'INVALID_CREDENTIALS');
  });

  it('concurrent issuances leave exactly one valid code (the last one issued)', async () => {
    await issueCode();
    const client = await testDb().pool.connect();
    let results: LightMyRequestResponse[];
    try {
      // Both issuances queue on the users lock, then run at once when it is released.
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [USERS_LOCK_KEY]);
      const pending = Promise.all([adminPost('reset-code'), adminPost('reset-code')]);
      await waitUntil(async () => (await lockWaiters()) >= 2, { message: 'two issuances waiting' });
      await client.query('commit');
      results = await pending;
    } finally {
      client.release();
    }
    const codes = results.map((res) => {
      expect(res.statusCode, res.payload).toBe(200);
      return ResetCodeResponse.parse(res.json()).code;
    });
    expect(await unusedCodeCount(bob.id)).toBe(1);
    const outcomes: number[] = [];
    for (const code of codes) outcomes.push((await resetRes(code)).statusCode);
    expect(outcomes.sort()).toEqual([204, 401]);
  });

  it('a reset racing a deactivation neither deadlocks nor survives it', async () => {
    const code = await issueCode();
    const client = await testDb().pool.connect();
    let deactivate: LightMyRequestResponse;
    let reset: LightMyRequestResponse;
    try {
      // Hold bob's row, queue the deactivation on it first, then the reset; release both.
      await client.query('begin');
      await client.query('select id from users where id = $1 for update', [bob.id]);
      const pendingDeactivate = adminPost('deactivate');
      await waitUntil(async () => (await lockWaiters()) >= 1, { message: 'deactivation waiting' });
      const pendingReset = resetRes(code);
      await waitUntil(async () => (await lockWaiters()) >= 2, { message: 'reset waiting' });
      await client.query('commit');
      [deactivate, reset] = await Promise.all([pendingDeactivate, pendingReset]);
    } finally {
      client.release();
    }
    expect(deactivate.statusCode, deactivate.payload).toBe(204);
    expectError(reset, 401, 'INVALID_CREDENTIALS');
    const rows = await testDb().db.select().from(sessions).where(eq(sessions.userId, bob.id));
    expect(rows).toEqual([]);
    // The password did not change.
    expect((await adminPost('reactivate')).statusCode).toBe(204);
    await login(app, 'bob');
  });
});
