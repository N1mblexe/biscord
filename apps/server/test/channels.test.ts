import { ChannelResponse, ChannelsResponse, LIMITS } from '@hearth/shared';
import { count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channels, messages } from '../src/db/schema.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel, insertDm, insertMessage } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

let app: FastifyInstance;
let admin: string;
let adminId: string;
let member: string;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  adminId = (await insertUser('admin', { role: 'admin' })).id;
  await insertUser('member');
  admin = await login(app, 'admin');
  member = await login(app, 'member');
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

async function nonDmCount(): Promise<number> {
  const [row] = await testDb().db.select({ n: count() }).from(channels).where(ne(channels.type, 'dm'));
  return row?.n ?? 0;
}

describe('channel admin routes', () => {
  it('members get 403 FORBIDDEN on create, rename, reorder and delete; anonymous gets 401', async () => {
    const general = await insertChannel('general');
    expectError(
      await api(app, 'POST', '/api/channels', { cookie: member, body: { type: 'text', name: 'x' } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await api(app, 'PATCH', `/api/channels/${general.id}`, { cookie: member, body: { name: 'y' } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await api(app, 'PUT', '/api/channels/order', { cookie: member, body: { ids: [general.id] } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await api(app, 'DELETE', `/api/channels/${general.id}`, { cookie: member }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await api(app, 'POST', '/api/channels', { body: { type: 'text', name: 'x' } }),
      401,
      'UNAUTHENTICATED',
    );
    expect(await nonDmCount()).toBe(1);
  });

  it('create appends at max(position) + 1 across text and voice, and trims the name', async () => {
    await insertChannel('a', { position: 4 });
    await insertChannel('b', { type: 'voice', position: 7 });
    const res = await api(app, 'POST', '/api/channels', {
      cookie: admin,
      body: { type: 'voice', name: '  lounge ' },
    });
    expect(res.statusCode, res.payload).toBe(201);
    expect(ChannelResponse.parse(res.json()).channel).toMatchObject({
      type: 'voice',
      name: 'lounge',
      position: 8,
    });
  });

  it('the first channel gets position 0; invalid bodies get VALIDATION', async () => {
    const res = await api(app, 'POST', '/api/channels', {
      cookie: admin,
      body: { type: 'text', name: 'general' },
    });
    expect(ChannelResponse.parse(res.json()).channel.position).toBe(0);
    for (const body of [
      { type: 'dm', name: 'x' },
      { type: 'text', name: '   ' },
      { type: 'text', name: 'x'.repeat(33) },
    ]) {
      expectError(await api(app, 'POST', '/api/channels', { cookie: admin, body }), 400, 'VALIDATION');
    }
  });

  it(`the ${LIMITS.maxChannels + 1}th channel gets 409 CHANNEL_LIMIT (DMs do not count)`, async () => {
    const other = await insertUser('other');
    await testDb()
      .db.insert(channels)
      .values(
        Array.from({ length: LIMITS.maxChannels - 1 }, (_, i) => ({
          type: 'text' as const,
          name: `c${i}`,
          position: i,
        })),
      );
    await insertDm(adminId, other.id);

    const ok = await api(app, 'POST', '/api/channels', {
      cookie: admin,
      body: { type: 'text', name: 'last' },
    });
    expect(ok.statusCode, ok.payload).toBe(201);
    expectError(
      await api(app, 'POST', '/api/channels', {
        cookie: admin,
        body: { type: 'voice', name: 'one-too-many' },
      }),
      409,
      'CHANNEL_LIMIT',
    );
    expect(await nonDmCount()).toBe(LIMITS.maxChannels);
  });

  it('concurrent creates at the cap: exactly one wins', async () => {
    await testDb()
      .db.insert(channels)
      .values(
        Array.from({ length: LIMITS.maxChannels - 1 }, (_, i) => ({
          type: 'text' as const,
          name: `c${i}`,
          position: i,
        })),
      );
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        api(app, 'POST', '/api/channels', { cookie: admin, body: { type: 'text', name: `n${i}` } }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await nonDmCount()).toBe(LIMITS.maxChannels);
  });

  it('rename: 200 with the new name; unknown id and DM ids get NOT_FOUND', async () => {
    const general = await insertChannel('general', { position: 3 });
    const res = await api(app, 'PATCH', `/api/channels/${general.id}`, {
      cookie: admin,
      body: { name: 'lobby' },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(ChannelResponse.parse(res.json()).channel).toEqual({
      id: general.id,
      type: 'text',
      name: 'lobby',
      position: 3,
    });

    expectError(
      await api(app, 'PATCH', '/api/channels/00000000-0000-4000-8000-000000000000', {
        cookie: admin,
        body: { name: 'x' },
      }),
      404,
      'NOT_FOUND',
    );
    const [a, b] = await Promise.all([insertUser('dm_a'), insertUser('dm_b')]);
    const dmId = await insertDm(a.id, b.id);
    expectError(
      await api(app, 'PATCH', `/api/channels/${dmId}`, { cookie: admin, body: { name: 'x' } }),
      404,
      'NOT_FOUND',
    );
    expectError(await api(app, 'DELETE', `/api/channels/${dmId}`, { cookie: admin }), 404, 'NOT_FOUND');
  });

  it('reorder rewrites positions 0..n-1 in the given order', async () => {
    const a = await insertChannel('a', { position: 0 });
    const b = await insertChannel('b', { type: 'voice', position: 5 });
    const c = await insertChannel('c', { position: 9 });
    const res = await api(app, 'PUT', '/api/channels/order', {
      cookie: admin,
      body: { ids: [c.id, a.id, b.id] },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(ChannelsResponse.parse(res.json()).channels.map((ch) => [ch.name, ch.position])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('reorder with a set that differs from the existing channels gets VALIDATION and changes nothing', async () => {
    const a = await insertChannel('a', { position: 0 });
    const b = await insertChannel('b', { position: 1 });
    const [u1, u2] = await Promise.all([insertUser('dm_a'), insertUser('dm_b')]);
    const dmId = await insertDm(u1.id, u2.id);
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const ids of [
      [a.id],
      [a.id, b.id, unknown],
      [a.id, b.id, dmId],
      [a.id, a.id, b.id],
      [b.id, unknown],
      [],
    ]) {
      expectError(
        await api(app, 'PUT', '/api/channels/order', { cookie: admin, body: { ids } }),
        400,
        'VALIDATION',
      );
    }
    const rows = await testDb().db.select().from(channels).where(ne(channels.type, 'dm'));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.position]))).toEqual({ a: 0, b: 1 });
  });

  it('delete gives 204 and cascades to the channel messages; unknown id gets NOT_FOUND', async () => {
    const author = await insertUser('author');
    const general = await insertChannel('general');
    const random = await insertChannel('random', { position: 1 });
    await insertMessage(general.id, author.id, 'one');
    await insertMessage(general.id, author.id, 'two');
    await insertMessage(random.id, author.id, 'kept');

    expect((await api(app, 'DELETE', `/api/channels/${general.id}`, { cookie: admin })).statusCode).toBe(204);
    const left = await testDb().db.select().from(messages);
    expect(left.map((m) => m.content)).toEqual(['kept']);
    expect(await testDb().db.select().from(channels).where(eq(channels.id, general.id))).toHaveLength(0);
    expectError(await api(app, 'DELETE', `/api/channels/${general.id}`, { cookie: admin }), 404, 'NOT_FOUND');
  });

  it('delete works for voice channels too (the LiveKit step arrives in Phase 6)', async () => {
    const voice = await insertChannel('lounge', { type: 'voice' });
    expect((await api(app, 'DELETE', `/api/channels/${voice.id}`, { cookie: admin })).statusCode).toBe(204);
    expect(await nonDmCount()).toBe(0);
  });
});
