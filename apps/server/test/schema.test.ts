import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { channels, dmChannels, invites, users } from '../src/db/schema.js';
import { APP_TABLES, closeTestDb, testDb, truncateAll } from './helpers/db.js';

const EXPECTED_TABLES = [
  'attachments',
  'channels',
  'dm_channels',
  'invites',
  'message_mentions',
  'message_reactions',
  'messages',
  'password_reset_codes',
  'read_states',
  'sessions',
  'users',
];

beforeEach(truncateAll);
afterAll(closeTestDb);

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

/** Awaits `promise`, expecting a Postgres check violation on `constraint`. */
async function expectCheckViolation(promise: Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${constraint} to reject the insert`).toBeInstanceOf(Error);
  // drizzle wraps driver errors in DrizzleQueryError; the pg error is its `cause`.
  const pgError = ((caught as Error).cause ?? caught) as PgErrorLike;
  expect(pgError.code).toBe('23514');
  expect(pgError.constraint).toBe(constraint);
}

async function insertUser(username: string): Promise<string> {
  const [row] = await testDb()
    .db.insert(users)
    .values({ username, displayName: username, passwordHash: 'not-a-real-hash' })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('insert returned no row');
  return row.id;
}

describe('schema', () => {
  it('migrations created all 11 app tables', async () => {
    const result = await testDb().db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    expect(APP_TABLES).toEqual(EXPECTED_TABLES);
  });

  it('a dm channel cannot have a name', async () => {
    await expectCheckViolation(
      testDb().db.insert(channels).values({ type: 'dm', name: 'nope' }),
      'channels_name_ck',
    );
  });

  it('a text channel must have a name', async () => {
    await expectCheckViolation(testDb().db.insert(channels).values({ type: 'text' }), 'channels_name_ck');
  });

  it('accepts a named text channel and an unnamed dm channel', async () => {
    const rows = await testDb()
      .db.insert(channels)
      .values([{ type: 'text', name: 'general' }, { type: 'dm' }])
      .returning({ id: channels.id });
    expect(rows).toHaveLength(2);
  });

  it('invite uses cannot exceed max_uses', async () => {
    await expectCheckViolation(
      testDb()
        .db.insert(invites)
        .values({ code: 'abc', maxUses: 2, uses: 3, expiresAt: new Date(Date.now() + 60_000) }),
      'invites_uses_ck',
    );
  });

  it('dm_channels requires user_low_id < user_high_id', async () => {
    const [a, b] = [await insertUser('alice'), await insertUser('bob')].sort();
    if (a === undefined || b === undefined) throw new Error('missing users');
    const [channel] = await testDb()
      .db.insert(channels)
      .values({ type: 'dm' })
      .returning({ id: channels.id });
    if (channel === undefined) throw new Error('missing channel');

    await expectCheckViolation(
      testDb().db.insert(dmChannels).values({ channelId: channel.id, userLowId: b, userHighId: a }),
      'dm_channels_order_ck',
    );
    await expectCheckViolation(
      testDb().db.insert(dmChannels).values({ channelId: channel.id, userLowId: a, userHighId: a }),
      'dm_channels_order_ck',
    );
    await testDb().db.insert(dmChannels).values({ channelId: channel.id, userLowId: a, userHighId: b });
  });
});
