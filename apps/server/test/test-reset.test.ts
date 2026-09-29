import {
  LIMITS,
  ListMessagesResponse,
  TestResetResponse,
  TestSeedMessagesResponse,
  UserResponse,
} from '@hearth/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_MUTATION_RATE_LIMIT, REACTION_RATE_LIMIT } from '../src/plugins/rate-limit.js';
import { invites, messages, users } from '../src/db/schema.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertInvite, insertUser, login, registerViaApi } from './helpers/auth.js';
import { insertChannel, insertMessage } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { freshUploadDir, listFiles, removeDir } from './helpers/uploads.js';

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

  it("empties this server's UPLOAD_DIR (only the trees it creates) and recreates tmp/ and avatars/", async () => {
    const dir = await freshUploadDir();
    const own = makeApp({
      env: testEnv({ HEARTH_TEST_MODE: 'true', HEARTH_TEST_TOKEN: TOKEN, UPLOAD_DIR: dir }),
    });
    try {
      await own.ready();
      const files = [
        `tmp/${randomUUID()}`,
        `avatars/${randomUUID()}`,
        `2026/09/${randomUUID()}`,
        `1999/01/${randomUUID()}`,
        'README',
        'other/keep.txt',
      ];
      for (const file of files) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), 'x');
      }
      expect((await reset(own, TOKEN)).statusCode).toBe(200);
      expect(await listFiles(dir)).toEqual(['README', 'other/keep.txt']);
      expect((await stat(path.join(dir, 'tmp'))).isDirectory()).toBe(true);
      expect((await stat(path.join(dir, 'avatars'))).isDirectory()).toBe(true);
    } finally {
      await own.close();
      await removeDir(dir);
    }
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

  it('clears the per-user reaction and per-admin mutation windows', async () => {
    const alice = await insertUser('alice', { role: 'admin' });
    const cookie = await login(app, 'alice');
    const general = await insertChannel('general');
    const message = await insertMessage(general.id, alice.id);
    const react = (id: number | string) =>
      api(app, 'PUT', `/api/messages/${id}/reactions/${encodeURIComponent('👍')}`, { cookie });
    const invite = () => api(app, 'POST', '/api/admin/invites', { cookie });
    for (let i = 0; i < REACTION_RATE_LIMIT.max; i++) expect((await react(message.id)).statusCode).toBe(204);
    expectError(await react(message.id), 429, 'RATE_LIMITED');
    for (let i = 0; i < ADMIN_MUTATION_RATE_LIMIT.max; i++) expect((await invite()).statusCode).toBe(201);
    expectError(await invite(), 429, 'RATE_LIMITED');

    expect((await reset(app, TOKEN)).statusCode).toBe(200);
    // Same user id as before (the windows are keyed by it), so only the reset can have cleared them.
    await testDb().db.insert(users).values(alice);
    const again = await login(app, 'alice');
    const channel = await insertChannel('general');
    const fresh = await insertMessage(channel.id, alice.id);
    const reacted = await api(app, 'PUT', `/api/messages/${fresh.id}/reactions/${encodeURIComponent('👍')}`, {
      cookie: again,
    });
    expect(reacted.statusCode, reacted.payload).toBe(204);
    expect((await api(app, 'POST', '/api/admin/invites', { cookie: again })).statusCode).toBe(201);
  });

  it('clears the per-user message send counters', async () => {
    const alice = await insertUser('alice');
    const general = await insertChannel('general');
    const cookie = await login(app, 'alice');
    const send = () =>
      api(app, 'POST', `/api/channels/${general.id}/messages`, { cookie, body: { content: 'hi' } });
    for (let i = 0; i < LIMITS.rateLimits.messageSend.max; i++) expect((await send()).statusCode).toBe(201);
    expectError(await send(), 429, 'RATE_LIMITED');

    expect((await reset(app, TOKEN)).statusCode).toBe(200);
    // The reset truncated users too: recreate the same fixtures and send again.
    const again = await insertUser('alice');
    expect(again.id).not.toBe(alice.id);
    const channel = await insertChannel('general');
    const res = await api(app, 'POST', `/api/channels/${channel.id}/messages`, {
      cookie: await login(app, 'alice'),
      body: { content: 'hi' },
    });
    expect(res.statusCode, res.payload).toBe(201);
  });
});

describe('POST /api/__test__/seed-messages', () => {
  function seed(target: FastifyInstance, body: unknown, token: string | null = TOKEN) {
    return api(
      target,
      'POST',
      '/api/__test__/seed-messages',
      token === null ? { body } : { body, headers: { 'x-test-token': token } },
    );
  }

  it('is a 404 when test mode is off', async () => {
    const normal = makeApp();
    try {
      const body = {
        channelId: '00000000-0000-4000-8000-000000000000',
        authorId: '00000000-0000-4000-8000-000000000000',
        count: 1,
      };
      expectError(await seed(normal, body), 404, 'NOT_FOUND');
    } finally {
      await normal.close();
    }
  });

  it('403 with a wrong or missing token (checked before anything else)', async () => {
    expectError(await seed(app, { nonsense: true }, 'wrong'), 403, 'FORBIDDEN');
    expectError(await seed(app, { nonsense: true }, null), 403, 'FORBIDDEN');
  });

  it('NOT_FOUND for an unknown channel or author; VALIDATION for a bad count', async () => {
    const alice = await insertUser('alice');
    const general = await insertChannel('general');
    const unknown = '00000000-0000-4000-8000-000000000000';
    expectError(await seed(app, { channelId: unknown, authorId: alice.id, count: 1 }), 404, 'NOT_FOUND');
    expectError(await seed(app, { channelId: general.id, authorId: unknown, count: 1 }), 404, 'NOT_FOUND');
    for (const count of [0, 501, 1.5]) {
      expectError(await seed(app, { channelId: general.id, authorId: alice.id, count }), 400, 'VALIDATION');
    }
    expect(await testDb().db.select().from(messages)).toHaveLength(0);
  });

  it('inserts "<prefix> 1".."<prefix> n" in id order, beyond the send rate limit, and returns first/last ids', async () => {
    const alice = await insertUser('alice');
    const general = await insertChannel('general');
    const res = await seed(app, { channelId: general.id, authorId: alice.id, count: 120, prefix: 'seed' });
    expect(res.statusCode, res.payload).toBe(200);
    const { firstId, lastId } = TestSeedMessagesResponse.parse(res.json());
    expect(Number(lastId) - Number(firstId)).toBe(119);

    const cookie = await login(app, 'alice');
    const page = await api(app, 'GET', `/api/channels/${general.id}/messages?limit=100`, { cookie });
    const listed = ListMessagesResponse.parse(page.json()).messages;
    expect(listed.at(-1)).toMatchObject({ id: lastId, content: 'seed 120', authorId: alice.id });
    expect(listed[0]?.content).toBe('seed 21');

    const def = await seed(app, { channelId: general.id, authorId: alice.id, count: 2 });
    const second = TestSeedMessagesResponse.parse(def.json());
    expect(Number(second.firstId)).toBe(Number(lastId) + 1);
    const rows = await testDb().db.select().from(messages);
    expect(
      rows
        .filter((m) => m.content.startsWith('msg '))
        .map((m) => m.content)
        .sort(),
    ).toEqual(['msg 1', 'msg 2']);
  });
});
