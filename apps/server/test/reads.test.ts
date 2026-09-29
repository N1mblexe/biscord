import {
  BootstrapResponse,
  MessageResponse,
  ReadStateResponse,
  ReadStateUpdatedPayload,
  type Message,
  type ReadState,
} from '@hearth/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStates } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
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
  for (const s of opened.splice(0)) s.client.disconnect();
  await app.close();
});
afterAll(closeTestDb);

async function connect(name: Name): Promise<RecordingClient> {
  const s = await connectRecording(baseUrl, cookies[name], { ignore: ['presence'] });
  opened.push(s);
  return s;
}

const markRead = (who: Name, channelId: string, messageId: unknown) =>
  api(app, 'POST', `/api/channels/${channelId}/read`, { cookie: cookies[who], body: { messageId } });

async function read(who: Name, channelId: string, messageId: string | number): Promise<ReadState> {
  const res = await markRead(who, channelId, String(messageId));
  expect(res.statusCode, res.payload).toBe(200);
  return ReadStateResponse.parse(res.json()).readState;
}

async function send(who: Name, channelId: string, content: string): Promise<Message> {
  const res = await api(app, 'POST', `/api/channels/${channelId}/messages`, {
    cookie: cookies[who],
    body: { content },
  });
  expect(res.statusCode, res.payload).toBe(201);
  return MessageResponse.parse(res.json()).message;
}

async function statesOf(who: Name): Promise<ReadState[]> {
  const res = await api(app, 'GET', '/api/bootstrap', { cookie: cookies[who] });
  expect(res.statusCode, res.payload).toBe(200);
  return BootstrapResponse.parse(res.json()).readStates;
}

async function stateOf(who: Name, channelId: string): Promise<ReadState | undefined> {
  return (await statesOf(who)).find((s) => s.channelId === channelId);
}

describe('POST /api/channels/:id/read', () => {
  it('is forward-only', async () => {
    const m1 = await insertMessage(general.id, users.alice.id, 'one');
    const m3 = await insertMessage(general.id, users.alice.id, 'three');
    expect(await read('bob', general.id, m3.id)).toEqual({
      channelId: general.id,
      lastReadMessageId: String(m3.id),
      unread: false,
      mentionCount: 0,
    });
    // Going back returns the unchanged state.
    expect((await read('bob', general.id, m1.id)).lastReadMessageId).toBe(String(m3.id));
    const [row] = await testDb()
      .db.select()
      .from(readStates)
      .where(and(eq(readStates.userId, users.bob.id), eq(readStates.channelId, general.id)));
    expect(row?.lastReadMessageId).toBe(m3.id);
  });

  it('a messageId from another channel, an unknown one, or a malformed body → VALIDATION', async () => {
    const random = await insertChannel('random', { position: 1 });
    const elsewhere = await insertMessage(random.id, users.alice.id);
    expectError(await markRead('bob', general.id, String(elsewhere.id)), 400, 'VALIDATION');
    expectError(await markRead('bob', general.id, '999999'), 400, 'VALIDATION');
    for (const messageId of ['0', 'abc', 12, undefined]) {
      expectError(await markRead('bob', general.id, messageId), 400, 'VALIDATION');
    }
    expect(await testDb().db.select().from(readStates)).toEqual([]);
  });

  it('access: unknown channel → 404, DM non-member → 403; a DM member can mark it read', async () => {
    expectError(await markRead('bob', '00000000-0000-4000-8000-000000000000', '1'), 404, 'NOT_FOUND');
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const m = await insertMessage(dmId, users.alice.id);
    expectError(await markRead('carol', dmId, String(m.id)), 403, 'FORBIDDEN');
    expect((await read('bob', dmId, m.id)).lastReadMessageId).toBe(String(m.id));
  });

  it('unread ignores my own messages', async () => {
    const theirs = await insertMessage(general.id, users.alice.id);
    expect(await stateOf('bob', general.id)).toMatchObject({ lastReadMessageId: '0', unread: true });
    await read('bob', general.id, theirs.id);
    // My own message after my read position doesn't make the channel unread (inserted directly, so the
    // send path's auto-advance isn't what makes this pass).
    await insertMessage(general.id, users.bob.id, 'mine');
    expect(await stateOf('bob', general.id)).toMatchObject({
      lastReadMessageId: String(theirs.id),
      unread: false,
    });
    await insertMessage(general.id, users.carol.id, 'carol again');
    expect(await stateOf('bob', general.id)).toMatchObject({ unread: true });
  });

  it('mentionCount counts my mentions after lastReadMessageId', async () => {
    const first = await send('alice', general.id, '@bob one');
    await send('alice', general.id, 'no mention');
    await send('carol', general.id, 'hey @BOB and @alice');
    expect(await stateOf('bob', general.id)).toMatchObject({ unread: true, mentionCount: 2 });
    expect(await stateOf('alice', general.id)).toMatchObject({ mentionCount: 1 });
    expect(await read('bob', general.id, first.id)).toMatchObject({ unread: true, mentionCount: 1 });
    const last = await send('alice', general.id, 'tail');
    expect(await read('bob', general.id, last.id)).toMatchObject({ unread: false, mentionCount: 0 });
  });

  it('readstate:updated goes to every socket of the caller and nobody else', async () => {
    const b1 = await connect('bob');
    const b2 = await connect('bob');
    const alice = await connect('alice');
    const m = await insertMessage(general.id, users.alice.id);
    const state = await read('bob', general.id, m.id);
    await b1.waitFor('readstate:updated');
    await b2.waitFor('readstate:updated');
    expect(b1.of('readstate:updated')).toEqual([{ readState: state }]);
    expect(b2.of('readstate:updated')).toEqual([{ readState: state }]);

    // Control: carol's message reaches alice after anything bob's read would have sent her.
    await send('carol', general.id, 'control');
    await alice.waitFor('message:created');
    expect(alice.of('readstate:updated')).toEqual([]);
  });
});

describe('sending moves my read state', () => {
  it('forward to my new message, emitting readstate:updated to me only', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    await insertMessage(general.id, users.bob.id, 'from bob');
    expect(await stateOf('alice', general.id)).toMatchObject({ unread: true });

    const mine = await send('alice', general.id, 'hi @bob');
    const expected: ReadState = {
      channelId: general.id,
      lastReadMessageId: mine.id,
      unread: false,
      mentionCount: 0,
    };
    expect(await stateOf('alice', general.id)).toEqual(expected);
    await alice.waitFor('readstate:updated');
    expect(alice.of('readstate:updated').map((p) => ReadStateUpdatedPayload.parse(p))).toEqual([
      { readState: expected },
    ]);
    // Bob got the message (after which any readstate for him would have arrived) but no read state.
    await bob.waitFor('message:created');
    expect(bob.of('readstate:updated')).toEqual([]);
    expect(await stateOf('bob', general.id)).toMatchObject({
      lastReadMessageId: '0',
      unread: true,
      mentionCount: 1,
    });
  });

  it('works for DMs too', async () => {
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const mine = await send('alice', dmId, 'hello');
    expect(await stateOf('alice', dmId)).toEqual({
      channelId: dmId,
      lastReadMessageId: mine.id,
      unread: false,
      mentionCount: 0,
    });
    // Every DM message mentions the other member.
    expect(await stateOf('bob', dmId)).toMatchObject({ unread: true, mentionCount: 1 });
  });
});

describe('bootstrap readStates', () => {
  it('covers every text channel and my DMs only (no voice, no other DMs)', async () => {
    const voice = await insertChannel('lounge', { type: 'voice', position: 1 });
    const random = await insertChannel('random', { position: 2 });
    const ab = await insertDm(users.alice.id, users.bob.id);
    const bc = await insertDm(users.bob.id, users.carol.id);

    const ids = (await statesOf('alice')).map((s) => s.channelId);
    expect(ids.sort()).toEqual([general.id, random.id, ab].sort());
    expect(ids).not.toContain(voice.id);
    expect(ids).not.toContain(bc);
    expect((await statesOf('bob')).map((s) => s.channelId).sort()).toEqual(
      [general.id, random.id, ab, bc].sort(),
    );
  });
});
