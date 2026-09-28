import { DmChannelResponse } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channels, dmChannels } from '../src/db/schema.js';
import type { UserRow } from '../src/db/types.js';
import { getOrCreateDm, orderPair } from '../src/services/dms.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

let app: FastifyInstance;
let alice: UserRow;
let bob: UserRow;
let aliceCookie: string;
let bobCookie: string;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  alice = await insertUser('alice');
  bob = await insertUser('bob');
  aliceCookie = await login(app, 'alice');
  bobCookie = await login(app, 'bob');
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

const openDm = (cookie: string, userId: string) => api(app, 'POST', '/api/dms', { cookie, body: { userId } });

async function dmRowCounts(): Promise<{ dms: number; dmChannels: number }> {
  const { db } = testDb();
  return {
    dms: (await db.select().from(dmChannels)).length,
    dmChannels: (await db.select().from(channels).where(eq(channels.type, 'dm'))).length,
  };
}

describe('POST /api/dms (get-or-create)', () => {
  it('creates with 201, then returns the same DM with 200 — from either side', async () => {
    const first = await openDm(aliceCookie, bob.id);
    expect(first.statusCode, first.payload).toBe(201);
    const created = DmChannelResponse.parse(first.json()).channel;
    expect(created).toMatchObject({ type: 'dm', otherUserId: bob.id });

    const again = await openDm(aliceCookie, bob.id);
    expect(again.statusCode).toBe(200);
    expect(DmChannelResponse.parse(again.json()).channel).toEqual(created);

    const fromBob = await openDm(bobCookie, alice.id);
    expect(fromBob.statusCode).toBe(200);
    expect(DmChannelResponse.parse(fromBob.json()).channel).toEqual({
      id: created.id,
      type: 'dm',
      otherUserId: alice.id,
    });
    expect(await dmRowCounts()).toEqual({ dms: 1, dmChannels: 1 });
  });

  it('stores the pair ordered (low < high), accepting an upper-case user id', async () => {
    const res = await openDm(aliceCookie, bob.id.toUpperCase());
    expect(res.statusCode, res.payload).toBe(201);
    const [row] = await testDb().db.select().from(dmChannels);
    expect([row?.userLowId, row?.userHighId]).toEqual([alice.id, bob.id].sort());
  });

  it('concurrent creates of the same pair produce exactly one DM (one 201, the rest 200)', async () => {
    const results = await Promise.all([
      openDm(aliceCookie, bob.id),
      openDm(bobCookie, alice.id),
      openDm(aliceCookie, bob.id),
      openDm(bobCookie, alice.id),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
    const ids = new Set(results.map((r) => DmChannelResponse.parse(r.json()).channel.id));
    expect(ids.size).toBe(1);
    // The losers' channel rows were rolled back / removed: no orphan DM channels.
    expect(await dmRowCounts()).toEqual({ dms: 1, dmChannels: 1 });
  });

  it('a create that loses the race on the pair index returns the winner and leaves no orphan channel', async () => {
    const { pool, db } = testDb();
    const { lowId, highId } = orderPair(alice.id, bob.id);
    const competitor = await pool.connect();
    try {
      // A competing transaction has inserted the pair but not committed yet.
      await competitor.query('begin');
      const inserted = await competitor.query<{ id: string }>(
        "insert into channels (type) values ('dm') returning id",
      );
      const winnerId = inserted.rows[0]?.id ?? '';
      await competitor.query(
        'insert into dm_channels (channel_id, user_low_id, user_high_id) values ($1, $2, $3)',
        [winnerId, lowId, highId],
      );

      // Our get-or-create misses the pre-check and blocks on dm_channels_pair_uq...
      const pending = getOrCreateDm(db, alice, bob.id);
      await waitUntil(
        async () => {
          const res = await pool.query<{ n: number }>(
            'select count(*)::int as n from pg_locks where not granted',
          );
          return (res.rows[0]?.n ?? 0) > 0;
        },
        { message: 'the insert to block on the pair index' },
      );
      // ...until the competitor commits: then it does nothing and returns the winner's DM.
      await competitor.query('commit');
      expect(await pending).toEqual({ channelId: winnerId, lowId, highId, created: false });
    } finally {
      competitor.release(true); // destroy: never return a connection with an open transaction to the pool
    }
    expect(await dmRowCounts()).toEqual({ dms: 1, dmChannels: 1 });
  });

  it('a DM with yourself or a deactivated user gets FORBIDDEN; an unknown user NOT_FOUND', async () => {
    expectError(await openDm(aliceCookie, alice.id), 403, 'FORBIDDEN');
    const gone = await insertUser('gone', { deactivated: true });
    expectError(await openDm(aliceCookie, gone.id), 403, 'FORBIDDEN');
    expectError(await openDm(aliceCookie, '00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND');
    expectError(await openDm(aliceCookie, 'not-a-uuid'), 400, 'VALIDATION');
    expectError(await api(app, 'POST', '/api/dms', { body: { userId: bob.id } }), 401, 'UNAUTHENTICATED');
    expect(await dmRowCounts()).toEqual({ dms: 0, dmChannels: 0 });
  });
});
