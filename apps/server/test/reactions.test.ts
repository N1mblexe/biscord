import {
  EMOJI_PALETTE,
  LIMITS,
  ListMessagesResponse,
  MessageResponse,
  ReactionEventPayload,
  type Message,
} from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageMentions, messageReactions, users as usersTable } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { seedMessages } from '../src/services/messages.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import {
  connectRecording,
  insertChannel,
  insertDm,
  insertMessage,
  listen,
  type RecordingClient,
} from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

type Name = 'alice' | 'bob' | 'carol';

let app: FastifyInstance;
let baseUrl: string;
let users: Record<Name, UserRow>;
const cookies: Record<Name, string> = { alice: '', bob: '', carol: '' };
const opened: RecordingClient[] = [];
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  baseUrl = await listen(app);
  users = {
    alice: await insertUser('alice'),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
  };
  for (const name of ['alice', 'bob', 'carol'] as const) cookies[name] = await login(app, name);
  general = await insertChannel('general');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of opened.splice(0)) s.client.disconnect();
  await app.close();
});
afterAll(closeTestDb);

async function connect(name: Name): Promise<RecordingClient> {
  const s = await connectRecording(baseUrl, cookies[name], { ignore: ['presence', 'readstate:updated'] });
  opened.push(s);
  return s;
}

const reactionUrl = (messageId: string | number, emoji: string): string =>
  `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;
const put = (who: Name, messageId: string | number, emoji: string) =>
  api(app, 'PUT', reactionUrl(messageId, emoji), { cookie: cookies[who] });
const del = (who: Name, messageId: string | number, emoji: string) =>
  api(app, 'DELETE', reactionUrl(messageId, emoji), { cookie: cookies[who] });

async function history(who: Name, channelId: string, query = ''): Promise<Message[]> {
  const res = await api(app, 'GET', `/api/channels/${channelId}/messages${query}`, { cookie: cookies[who] });
  expect(res.statusCode, res.payload).toBe(200);
  return ListMessagesResponse.parse(res.json()).messages;
}

async function reactionRows(messageId: number): Promise<{ userId: string; emoji: string }[]> {
  return testDb()
    .db.select({ userId: messageReactions.userId, emoji: messageReactions.emoji })
    .from(messageReactions)
    .where(eq(messageReactions.messageId, messageId));
}

let controlCount = 0;
/** Positive control: a text-channel message every listed socket must receive, after everything before it. */
async function control(sockets: readonly RecordingClient[]): Promise<void> {
  controlCount += 1;
  const n = controlCount;
  const res = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
    cookie: cookies.carol,
    body: { content: `control ${n}` },
  });
  expect(res.statusCode).toBe(201);
  await Promise.all(
    sockets.map((s) =>
      waitUntil(() => JSON.stringify(s.of('message:created')).includes(`control ${n}`), {
        message: `control ${n}`,
      }),
    ),
  );
}

describe('PUT / DELETE /api/messages/:id/reactions/:emoji', () => {
  it('is idempotent and broadcasts only actual changes', async () => {
    const alice = await connect('alice');
    const carol = await connect('carol');
    const message = await insertMessage(general.id, users.alice.id);
    const event = {
      channelId: general.id,
      messageId: String(message.id),
      emoji: '👍',
      userId: users.bob.id,
    };

    expect((await put('bob', message.id, '👍')).statusCode).toBe(204);
    expect((await put('bob', message.id, '👍')).statusCode).toBe(204);
    expect(await reactionRows(message.id)).toEqual([{ userId: users.bob.id, emoji: '👍' }]);
    expect((await del('bob', message.id, '👍')).statusCode).toBe(204);
    expect((await del('bob', message.id, '👍')).statusCode).toBe(204);
    // Removing a reaction nobody made is a no-op too.
    expect((await del('bob', message.id, '🎉')).statusCode).toBe(204);
    expect(await reactionRows(message.id)).toEqual([]);

    await control([alice, carol]);
    for (const s of [alice, carol]) {
      const reactionEvents = s.events.filter((e) => e.event.startsWith('reaction:'));
      expect(reactionEvents).toEqual([
        { event: 'reaction:added', payload: event },
        { event: 'reaction:removed', payload: event },
      ]);
      for (const { payload } of reactionEvents)
        expect(() => ReactionEventPayload.parse(payload)).not.toThrow();
    }
  });

  it('DM reactions reach only the two members', async () => {
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const alice = await connect('alice');
    const bob = await connect('bob');
    const carol = await connect('carol');
    const message = await insertMessage(dmId, users.alice.id);
    expect((await put('bob', message.id, '❤️')).statusCode).toBe(204);
    await alice.waitFor('reaction:added');
    await bob.waitFor('reaction:added');
    await control([carol]);
    expect(carol.of('reaction:added')).toEqual([]);
  });

  it(`the ${LIMITS.distinctReactionsPerMessage + 1}st distinct emoji → CONFLICT; existing emojis still work`, async () => {
    const message = await insertMessage(general.id, users.alice.id);
    const palette = EMOJI_PALETTE.slice(0, LIMITS.distinctReactionsPerMessage);
    for (const emoji of palette) expect((await put('alice', message.id, emoji)).statusCode).toBe(204);
    const extra = EMOJI_PALETTE[LIMITS.distinctReactionsPerMessage];
    expectError(await put('bob', message.id, extra), 409, 'CONFLICT');
    // Joining an emoji already present, or re-PUTting one's own, is fine at the cap.
    expect((await put('bob', message.id, palette[0] ?? '')).statusCode).toBe(204);
    expect((await put('alice', message.id, palette[1] ?? '')).statusCode).toBe(204);
    // Freeing a slot lets a new emoji in.
    expect((await del('alice', message.id, palette[2] ?? '')).statusCode).toBe(204);
    expect((await put('bob', message.id, extra)).statusCode).toBe(204);
  });

  it('concurrent PUTs of different new emojis never exceed the cap (row lock)', async () => {
    const message = await insertMessage(general.id, users.alice.id);
    const cap = LIMITS.distinctReactionsPerMessage;
    for (const emoji of EMOJI_PALETTE.slice(0, cap - 1)) await put('alice', message.id, emoji);
    const contenders = EMOJI_PALETTE.slice(cap - 1, cap + 4);
    const results = await Promise.all(contenders.map((emoji) => put('bob', message.id, emoji)));
    expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(contenders.length - 1);
    const distinct = new Set((await reactionRows(message.id)).map((r) => r.emoji));
    expect(distinct.size).toBe(cap);
  });

  it('an invalid emoji or message id → VALIDATION; unknown message → NOT_FOUND', async () => {
    const message = await insertMessage(general.id, users.alice.id);
    for (const emoji of ['abc', '👍👍', ':+1:', '❤', 'a'.repeat(65), ' 👍']) {
      expectError(await put('bob', message.id, emoji), 400, 'VALIDATION');
      expectError(await del('bob', message.id, emoji), 400, 'VALIDATION');
    }
    expectError(await put('bob', 0, '👍'), 400, 'VALIDATION');
    expectError(await put('bob', 'abc', '👍'), 400, 'VALIDATION');
    expectError(await put('bob', 999999, '👍'), 404, 'NOT_FOUND');
    expect(await reactionRows(message.id)).toEqual([]);
  });

  it('a DM non-member → 403; a read-only DM → 403', async () => {
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const message = await insertMessage(dmId, users.alice.id);
    expectError(await put('carol', message.id, '👍'), 403, 'FORBIDDEN');
    expectError(await del('carol', message.id, '👍'), 403, 'FORBIDDEN');

    expect((await put('bob', message.id, '👍')).statusCode).toBe(204);
    await testDb()
      .db.update(usersTable)
      .set({ deactivatedAt: new Date() })
      .where(eq(usersTable.id, users.bob.id));
    expectError(await put('alice', message.id, '🎉'), 403, 'FORBIDDEN');
    expectError(await del('alice', message.id, '👍'), 403, 'FORBIDDEN');
  });

  it('anonymous → 401', async () => {
    const message = await insertMessage(general.id, users.alice.id);
    expectError(await api(app, 'PUT', reactionUrl(message.id, '👍')), 401, 'UNAUTHENTICATED');
  });
});

describe('Message.reactions', () => {
  it('emojis ordered by first reaction, userIds by reaction time; edits keep reactions', async () => {
    const res = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: 'react to me @bob' },
    });
    const message = MessageResponse.parse(res.json()).message;
    const id = Number(message.id);
    await put('carol', id, '👍');
    await put('alice', id, '❤️');
    await put('bob', id, '👍');
    await put('bob', id, '🎉');
    await put('alice', id, '👍');
    // Removing and re-adding moves a user to the end of that emoji's list.
    await del('bob', id, '👍');
    await put('bob', id, '👍');

    const expected = [
      { emoji: '👍', userIds: [users.carol.id, users.alice.id, users.bob.id] },
      { emoji: '❤️', userIds: [users.alice.id] },
      { emoji: '🎉', userIds: [users.bob.id] },
    ];
    const [fromHistory] = await history('bob', general.id);
    expect(fromHistory?.reactions).toEqual(expected);
    expect(fromHistory?.mentionUserIds).toEqual([users.bob.id]);

    const edit = await api(app, 'PATCH', `/api/messages/${message.id}`, {
      cookie: cookies.alice,
      body: { content: 'edited' },
    });
    const edited = MessageResponse.parse(edit.json()).message;
    expect(edited.reactions).toEqual(expected);
    expect(edited.mentionUserIds).toEqual([]);
  });

  it('history pages aggregate reactions and mentions per message with a bounded query count (no N+1)', async () => {
    const { db, pool } = testDb();
    const { firstId, lastId } = await seedMessages(db, {
      channelId: general.id,
      authorId: users.alice.id,
      count: 60,
      prefix: 'm',
    });
    // Every message gets reactions and a mention, differing per message so mix-ups would show. Bob's
    // reactions go in first (an earlier statement, so an earlier `now()`) and carol's 🔥 after them.
    const emojiFor = (id: number): string => EMOJI_PALETTE[id % 5] ?? '👍';
    const ids = Array.from({ length: lastId - firstId + 1 }, (_, i) => firstId + i);
    await db
      .insert(messageReactions)
      .values(ids.map((id) => ({ messageId: id, userId: users.bob.id, emoji: emojiFor(id) })));
    await db
      .insert(messageReactions)
      .values(
        ids
          .filter((id) => id % 2 === 0)
          .map((id) => ({ messageId: id, userId: users.carol.id, emoji: '🔥' })),
      );
    await db.insert(messageMentions).values(
      ids.map((id) => ({
        messageId: id,
        userId: id % 3 === 0 ? users.carol.id : users.bob.id,
        channelId: general.id,
      })),
    );

    const query = vi.spyOn(pool, 'query');
    const countQueries = async (q: string): Promise<{ n: number; page: Message[] }> => {
      query.mockClear();
      const page = await history('alice', general.id, q);
      return { n: query.mock.calls.length, page };
    };

    const one = await countQueries('?limit=1');
    const full = await countQueries('?limit=50');
    const hundred = await countQueries('?limit=100');
    expect(one.page).toHaveLength(1);
    expect(full.page).toHaveLength(50);
    expect(hundred.page).toHaveLength(60);
    // session + channel access + page + reactions + mentions, independent of the page size.
    expect(full.n).toBe(one.n);
    expect(hundred.n).toBe(one.n);
    expect(full.n).toBeLessThanOrEqual(6);

    for (const message of hundred.page) {
      const id = Number(message.id);
      const bobs = { emoji: emojiFor(id), userIds: [users.bob.id] };
      const expected = id % 2 === 0 ? [bobs, { emoji: '🔥', userIds: [users.carol.id] }] : [bobs];
      expect(message.reactions, `message ${id}`).toEqual(expected);
      expect(message.mentionUserIds).toEqual([id % 3 === 0 ? users.carol.id : users.bob.id]);
    }
  });

  it('an empty page runs no aggregate queries', async () => {
    const { pool } = testDb();
    const query = vi.spyOn(pool, 'query');
    await history('alice', general.id);
    const emptyCount = query.mock.calls.length;
    await insertMessage(general.id, users.alice.id);
    query.mockClear();
    await history('alice', general.id);
    expect(query.mock.calls.length).toBe(emptyCount + 2);
  });
});
