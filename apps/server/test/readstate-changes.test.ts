import { BootstrapResponse, Message, MessageResponse, type ReadState } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { makeApp } from './helpers/app.js';
import { api, insertUser, login } from './helpers/auth.js';
import {
  connectRecording,
  insertChannel,
  insertDm,
  listen,
  type RecordedEvent,
  type RecordingClient,
} from './helpers/chat.js';
import { closeTestDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

// CONTRACTS B.9 rule 6: deleting or editing a message that changes someone's unread flag or mention count
// sends that user a fresh `readstate:updated` (and nobody else one).

type Name = 'alice' | 'bob' | 'carol';
const NAMES = ['alice', 'bob', 'carol'] as const;

let app: FastifyInstance;
let baseUrl: string;
let users: Record<Name, UserRow>;
const cookies: Record<Name | 'dave', string> = { alice: '', bob: '', carol: '', dave: '' };
const opened: RecordingClient[] = [];
let general: ChannelRow;
/** Where dave (never connected) posts control messages: they reach every socket and touch no tested state. */
let control: ChannelRow;

async function seed(aliceRole: 'admin' | 'member' = 'member'): Promise<void> {
  await truncateAll();
  users = {
    alice: await insertUser('alice', { role: aliceRole }),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
  };
  await insertUser('dave');
  for (const name of [...NAMES, 'dave'] as const) cookies[name] = await login(app, name);
  general = await insertChannel('general');
  control = await insertChannel('control', { position: 1 });
}

beforeEach(async () => {
  app = makeApp();
  baseUrl = await listen(app);
  await seed();
});
afterEach(async () => {
  for (const s of opened.splice(0)) s.client.disconnect();
  await app.close();
});
afterAll(closeTestDb);

type Sockets = Record<Name, RecordingClient>;

async function connectAll(): Promise<Sockets> {
  const result = {} as Sockets;
  for (const name of NAMES) {
    const s = await connectRecording(baseUrl, cookies[name], { ignore: ['presence'] });
    opened.push(s);
    result[name] = s;
  }
  return result;
}

async function send(who: Name | 'dave', channelId: string, content: string): Promise<Message> {
  const res = await api(app, 'POST', `/api/channels/${channelId}/messages`, {
    cookie: cookies[who],
    body: { content },
  });
  expect(res.statusCode, res.payload).toBe(201);
  return MessageResponse.parse(res.json()).message;
}

async function remove(who: Name, messageId: string): Promise<void> {
  const res = await api(app, 'DELETE', `/api/messages/${messageId}`, { cookie: cookies[who] });
  expect(res.statusCode, res.payload).toBe(204);
}

async function edit(who: Name, messageId: string, content: string): Promise<void> {
  const res = await api(app, 'PATCH', `/api/messages/${messageId}`, {
    cookie: cookies[who],
    body: { content },
  });
  expect(res.statusCode, res.payload).toBe(200);
}

async function markRead(who: Name, channelId: string, messageId: string): Promise<void> {
  const res = await api(app, 'POST', `/api/channels/${channelId}/read`, {
    cookie: cookies[who],
    body: { messageId },
  });
  expect(res.statusCode, res.payload).toBe(200);
}

async function stateOf(who: Name, channelId: string): Promise<ReadState | undefined> {
  const res = await api(app, 'GET', '/api/bootstrap', { cookie: cookies[who] });
  return BootstrapResponse.parse(res.json()).readStates.find((s) => s.channelId === channelId);
}

const isMessage = (e: RecordedEvent, id: string): boolean =>
  e.event === 'message:created' && MessageResponse.parse(e.payload).message.id === id;

/**
 * Dave posts a control message and every socket waits for it: whatever the server emitted before it has
 * arrived by then, in order. Returns each socket's events from `marks` up to (not including) the control.
 */
async function eventsUntilControl(
  sockets: Sockets,
  marks: Record<Name, number>,
): Promise<Record<Name, RecordedEvent[]>> {
  const { id } = await send('dave', control.id, 'control');
  const result = {} as Record<Name, RecordedEvent[]>;
  for (const name of NAMES) {
    const events = sockets[name].events;
    await waitUntil(() => events.slice(marks[name]).some((e) => isMessage(e, id)), {
      message: `the control message on ${name}'s socket`,
    });
    const window = events.slice(marks[name]);
    result[name] = window.slice(
      0,
      window.findIndex((e) => isMessage(e, id)),
    );
  }
  return result;
}

/** Lets everything emitted so far arrive, then marks each socket's position. */
async function settle(sockets: Sockets): Promise<Record<Name, number>> {
  const zero = { alice: 0, bob: 0, carol: 0 };
  await eventsUntilControl(sockets, zero);
  return {
    alice: sockets.alice.events.length,
    bob: sockets.bob.events.length,
    carol: sockets.carol.events.length,
  };
}

/** The `readstate:updated` payloads each user received between `marks` and a fresh control message. */
async function readStatesSince(
  sockets: Sockets,
  marks: Record<Name, number>,
): Promise<Record<Name, unknown[]>> {
  const events = await eventsUntilControl(sockets, marks);
  const result = {} as Record<Name, unknown[]>;
  for (const name of NAMES) {
    result[name] = events[name].filter((e) => e.event === 'readstate:updated').map((e) => e.payload);
  }
  return result;
}

const state = (channelId: string, lastReadMessageId: string, unread: boolean, mentionCount: number) => ({
  readState: { channelId, lastReadMessageId, unread, mentionCount },
});

describe('readstate:updated after a message delete', () => {
  it('a deleted unread @mention clears the mention and unread flag of everyone who counted it', async () => {
    const sockets = await connectAll();
    const m = await send('alice', general.id, 'hey @bob');
    expect(await stateOf('bob', general.id)).toMatchObject({ unread: true, mentionCount: 1 });
    expect(await stateOf('carol', general.id)).toMatchObject({ unread: true, mentionCount: 0 });
    const marks = await settle(sockets);

    await remove('alice', m.id);
    const got = await readStatesSince(sockets, marks);
    expect(got.bob).toEqual([state(general.id, '0', false, 0)]);
    expect(got.carol).toEqual([state(general.id, '0', false, 0)]);
    // The author's own state didn't change.
    expect(got.alice).toEqual([]);
    expect(await stateOf('bob', general.id)).toEqual(state(general.id, '0', false, 0).readState);
  });

  it('the event comes after message:deleted on the same socket', async () => {
    const sockets = await connectAll();
    const m = await send('alice', general.id, 'hey @bob');
    const marks = await settle(sockets);
    await remove('alice', m.id);
    const events = await eventsUntilControl(sockets, marks);
    expect(events.bob.map((e) => e.event)).toEqual(['message:deleted', 'readstate:updated']);
  });

  it('only users whose state changed get one: read positions and remaining unread messages count', async () => {
    const sockets = await connectAll();
    const older = await send('carol', general.id, 'older, from carol');
    const m = await send('alice', general.id, 'hey @bob');
    // Bob read everything: the delete changes nothing for him.
    await markRead('bob', general.id, m.id);
    const marks = await settle(sockets);

    await remove('alice', m.id);
    const got = await readStatesSince(sockets, marks);
    expect(got.bob).toEqual([]);
    // Carol: alice's message was her only unread one (her own message is never unread for her).
    expect(got.carol).toEqual([state(general.id, older.id, false, 0)]);
    // Alice still has carol's older message unread: no change for her.
    expect(got.alice).toEqual([]);
  });

  it('a mention next to other unread messages: unread stays true, the count drops', async () => {
    const sockets = await connectAll();
    await send('carol', general.id, 'unrelated');
    const m = await send('alice', general.id, 'hey @bob');
    const marks = await settle(sockets);
    await remove('alice', m.id);
    const got = await readStatesSince(sockets, marks);
    expect(got.bob).toEqual([state(general.id, '0', true, 0)]);
  });

  it('a deleted DM message clears the other member (DM messages always mention them)', async () => {
    const sockets = await connectAll();
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const m = await send('alice', dmId, 'psst');
    expect(await stateOf('bob', dmId)).toMatchObject({ unread: true, mentionCount: 1 });
    const marks = await settle(sockets);

    await remove('alice', m.id);
    const got = await readStatesSince(sockets, marks);
    expect(got.bob).toEqual([state(dmId, '0', false, 0)]);
    expect(got.alice).toEqual([]);
    expect(got.carol).toEqual([]);
    expect(await stateOf('bob', dmId)).toMatchObject({ unread: false, mentionCount: 0 });
  });

  it("an admin deleting someone else's message updates every reader who counted it", async () => {
    await seed('admin');
    const sockets = await connectAll();
    const m = await send('carol', general.id, 'hey @bob');
    const marks = await settle(sockets);
    await remove('alice', m.id);
    const got = await readStatesSince(sockets, marks);
    expect(got.bob).toEqual([state(general.id, '0', false, 0)]);
    expect(got.alice).toEqual([state(general.id, '0', false, 0)]);
    expect(got.carol).toEqual([]);
  });
});

describe('readstate:updated after a message edit', () => {
  it('moving a mention updates exactly the dropped and the added user', async () => {
    const sockets = await connectAll();
    const m = await send('alice', general.id, 'hey @bob');
    const marks = await settle(sockets);

    await edit('alice', m.id, 'hey @carol');
    const got = await readStatesSince(sockets, marks);
    expect(got.bob).toEqual([state(general.id, '0', true, 0)]);
    expect(got.carol).toEqual([state(general.id, '0', true, 1)]);
    expect(got.alice).toEqual([]);
  });

  it('an edit that keeps the mentions, or adds one on an already-read message, sends nothing', async () => {
    const sockets = await connectAll();
    const m = await send('alice', general.id, 'hey @bob');
    await markRead('carol', general.id, m.id);
    const marks = await settle(sockets);

    await edit('alice', m.id, 'hey @bob, edited');
    await edit('alice', m.id, 'hey @bob and @carol'); // carol has read it: her count can't move
    const got = await readStatesSince(sockets, marks);
    expect(got).toEqual({ alice: [], bob: [], carol: [] });
  });
});
