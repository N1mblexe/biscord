import { LIMITS, TestResetResponse, UserResponse } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invites, users } from '../src/db/schema.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertInvite, insertUser, registerViaApi } from './helpers/auth.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

const TOKEN = 'unit-test-token';

let app: FastifyInstance;

beforeEach(async () => {
  await truncateAll();
  app = makeApp({ env: testEnv({ HEARTH_TEST_MODE: 'true', HEARTH_TEST_TOKEN: TOKEN }) });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

function reset(target: FastifyInstance, token?: string) {
  return api(
    target,
    'POST',
    '/api/__test__/reset',
    token === undefined ? {} : { headers: { 'x-test-token': token } },
  );
}

describe('POST /api/__test__/reset', () => {
  it('is a 404 when test mode is off', async () => {
    const normal = makeApp();
    try {
      expectError(await reset(normal, TOKEN), 404, 'NOT_FOUND');
    } finally {
      await normal.close();
    }
  });

  it('403 with a wrong or missing token', async () => {
    expectError(await reset(app, 'wrong'), 403, 'FORBIDDEN');
    expectError(await reset(app, `${TOKEN}x`), 403, 'FORBIDDEN');
    expectError(await reset(app), 403, 'FORBIDDEN');
  });

  it('requires the CSRF header', async () => {
    const res = await api(app, 'POST', '/api/__test__/reset', {
      headers: { 'x-test-token': TOKEN },
      noCsrf: true,
    });
    expectError(res, 403, 'FORBIDDEN');
    expect(await testDb().db.select().from(invites)).toHaveLength(0);
  });

  it('truncates every table and returns a single-use admin invite', async () => {
    await insertUser('alice');
    await insertInvite();

    const res = await reset(app, TOKEN);
    expect(res.statusCode, res.payload).toBe(200);
    const { adminInviteCode } = TestResetResponse.parse(res.json());

    expect(await testDb().db.select().from(users)).toHaveLength(0);
    const rows = await testDb().db.select().from(invites);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: adminInviteCode, grantsRole: 'admin', maxUses: 1, uses: 0 });

    const reg = await registerViaApi(app, 'root', adminInviteCode);
    expect(reg.statusCode).toBe(201);
    expect(UserResponse.parse(reg.json()).user.role).toBe('admin');
    expectError(await registerViaApi(app, 'second', adminInviteCode), 400, 'INVITE_INVALID');
  });

  it('clears the in-memory rate-limit counters', async () => {
    const body = { username: 'nobody', password: 'wrong' };
    for (let i = 0; i < LIMITS.rateLimits.login.max; i++) {
      await api(app, 'POST', '/api/auth/login', { body });
    }
    expectError(await api(app, 'POST', '/api/auth/login', { body }), 429, 'RATE_LIMITED');
    expect((await reset(app, TOKEN)).statusCode).toBe(200);
    expectError(await api(app, 'POST', '/api/auth/login', { body }), 401, 'INVALID_CREDENTIALS');
  });
});
