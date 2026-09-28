import {
  ChannelResponse,
  DmChannelResponse,
  MessageDeletedPayload,
  MessageEventPayload,
  MessageResponse,
  serverEventSchemas,
  type ServerEventName,
} from '@hearth/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import {
  connectRecording,
  insertChannel,
  insertDm,
  listen,
  mentionsChannel,
  type RecordingClient,
} from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

let app: FastifyInstance;
let general: ChannelRow;
type Name = 'alice' | 'bob' | 'carol';
const NAMES: readonly Name[] = ['alice', 'bob', 'carol'];
let users: Record<Name, UserRow>;
const cookies: Record<Name, string> = { alice: '', bob: '', carol: '' };
let sockets: Partial<Record<Name, RecordingClient>> = {};

function socket(name: Name): RecordingClient {
  const s = sockets[name];
  if (s === undefined) throw new Error(`no socket for ${name}`);
  return s;
}

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  const baseUrl = await listen(app);
  users = {
    alice: await insertUser('alice', { role: 'admin' }),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
  };
  for (const name of NAMES) {
    cookies[name] = await login(app, name);
    sockets[name] = await connectRecording(baseUrl, cookies[name]);
  }
  general = await insertChannel('general');
});
afterEach(async () => {
  for (const name of NAMES) sockets[name]?.client.disconnect();
  sockets = {};
  await app.close();
});
afterAll(closeTestDb);

const post = (who: Name, channelId: string, body: unknown) =>
  api(app, 'POST', `/api/channels/${channelId}/messages`, { cookie: cookies[who], body });

function createdContents(name: Name): string[] {
  return socket(name)
    .of('message:created')
    .map((p) => MessageEventPayload.parse(p).message.content);
}

let controlCount = 0;
/**
 * Positive control: a text-channel message every socket must receive. Socket.IO keeps per-connection order,
 * so once it has arrived, anything emitted before it would have arrived too.
 */
async function control(): Promise<string> {
  controlCount += 1;
  const content = `control ${controlCount}`;
  expect((await post('alice', general.id, { content })).statusCode).toBe(201);
  await waitUntil(() => NAMES.every((name) => createdContents(name).includes(content)), {
    message: `${content} on every socket`,
  });
  return content;
}

/** Every recorded payload is valid for its event (the server also asserts this outside production). */
function expectValidPayloads(): void {
  for (const name of NAMES) {
    for (const { event, payload } of socket(name).events) {
      expect(() => serverEventSchemas[event as ServerEventName].parse(payload)).not.toThrow();
    }
  }
}

describe('message audience', () => {
  it('a text-channel message reaches all three users, with the nonce', async () => {
    const res = await post('bob', general.id, { content: 'hi all', nonce: 'nonce-1' });
    const message = MessageResponse.parse(res.json()).message;
    await Promise.all(NAMES.map((name) => socket(name).waitFor('message:created')));
    for (const name of NAMES) {
      expect(socket(name).of('message:created')).toEqual([{ message }]);
    }
    expect(message.nonce).toBe('nonce-1');
    expectValidPayloads();
  });

  it('DM created/updated/deleted events reach only the two members', async () => {
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const res = await post('alice', dmId, { content: 'secret', nonce: 'dm-nonce' });
    const message = MessageResponse.parse(res.json()).message;
    const edit = await api(app, 'PATCH', `/api/messages/${message.id}`, {
      cookie: cookies.alice,
      body: { content: 'secret v2' },
    });
    expect(edit.statusCode).toBe(200);
    expect(
      (await api(app, 'DELETE', `/api/messages/${message.id}`, { cookie: cookies.bob })).statusCode,
    ).toBe(403);
    expect(
      (await api(app, 'DELETE', `/api/messages/${message.id}`, { cookie: cookies.alice })).statusCode,
    ).toBe(204);

    await control();
    for (const name of ['alice', 'bob'] as const) {
      const s = socket(name);
      expect(s.of('message:created')[0]).toEqual({ message });
      expect(MessageEventPayload.parse(s.of('message:updated')[0]).message.content).toBe('secret v2');
      expect(s.of('message:deleted').map((p) => MessageDeletedPayload.parse(p))).toEqual([
        { channelId: dmId, messageId: message.id },
      ]);
    }
    // Carol got the control message, and nothing at all about the DM.
    expect(mentionsChannel(socket('carol').events, dmId)).toBe(false);
    expect(socket('carol').events.map((e) => e.event)).toEqual(['message:created']);
    expectValidPayloads();
  });

  it('text-channel edits and deletes reach everyone', async () => {
    const message = MessageResponse.parse((await post('bob', general.id, { content: 'v1' })).json()).message;
    await api(app, 'PATCH', `/api/messages/${message.id}`, { cookie: cookies.bob, body: { content: 'v2' } });
    // Admin delete in a text channel.
    expect(
      (await api(app, 'DELETE', `/api/messages/${message.id}`, { cookie: cookies.alice })).statusCode,
    ).toBe(204);
    await Promise.all(NAMES.map((name) => socket(name).waitFor('message:deleted')));
    for (const name of NAMES) {
      expect(socket(name).events.map((e) => e.event)).toEqual([
        'message:created',
        'message:updated',
        'message:deleted',
      ]);
    }
  });

  it('a failed write emits nothing', async () => {
    const { db } = testDb();
    // Force a DB failure on insert: the route passes validation and access, then the INSERT is rejected.
    await db.execute(
      sql.raw("alter table messages add constraint test_no_boom_ck check (content <> 'boom') not valid"),
    );
    try {
      expectError(await post('bob', general.id, { content: 'boom' }), 500, 'INTERNAL');
      // Rejected before any write: no event either.
      expectError(await post('bob', general.id, { content: '' }), 400, 'VALIDATION');
    } finally {
      await db.execute(sql.raw('alter table messages drop constraint test_no_boom_ck'));
    }
    const content = await control();
    for (const name of NAMES) {
      expect(socket(name).events.map((e) => e.event)).toEqual(['message:created']);
      expect(createdContents(name)).toEqual([content]);
    }
  });
});

describe('channel and DM audiences', () => {
  it('channel:created / updated / reordered / deleted reach every user', async () => {
    const created = await api(app, 'POST', '/api/channels', {
      cookie: cookies.alice,
      body: { type: 'voice', name: 'lounge' },
    });
    const channel = ChannelResponse.parse(created.json()).channel;
    await api(app, 'PATCH', `/api/channels/${channel.id}`, {
      cookie: cookies.alice,
      body: { name: 'hangout' },
    });
    await api(app, 'PUT', '/api/channels/order', {
      cookie: cookies.alice,
      body: { ids: [channel.id, general.id] },
    });
    await api(app, 'DELETE', `/api/channels/${channel.id}`, { cookie: cookies.alice });

    await Promise.all(NAMES.map((name) => socket(name).waitFor('channel:deleted')));
    for (const name of NAMES) {
      const s = socket(name);
      expect(s.events.map((e) => e.event)).toEqual([
        'channel:created',
        'channel:updated',
        'channels:reordered',
        'channel:deleted',
      ]);
      expect(s.of('channel:created')).toEqual([{ channel }]);
      expect(s.of('channel:updated')).toEqual([{ channel: { ...channel, name: 'hangout' } }]);
      expect(s.of('channels:reordered')).toEqual([
        {
          channels: [
            { ...channel, name: 'hangout', position: 0 },
            { id: general.id, type: 'text', name: 'general', position: 1 },
          ],
        },
      ]);
      expect(s.of('channel:deleted')).toEqual([{ channelId: channel.id }]);
    }
    expectValidPayloads();
  });

  it('dm:created reaches both members from their own side, only once, and never a third user', async () => {
    const first = await api(app, 'POST', '/api/dms', {
      cookie: cookies.alice,
      body: { userId: users.bob.id },
    });
    expect(first.statusCode).toBe(201);
    const dmId = DmChannelResponse.parse(first.json()).channel.id;
    const again = await api(app, 'POST', '/api/dms', {
      cookie: cookies.bob,
      body: { userId: users.alice.id },
    });
    expect(again.statusCode).toBe(200);

    await control();
    expect(socket('alice').of('dm:created')).toEqual([
      { channel: { id: dmId, type: 'dm', otherUserId: users.bob.id } },
    ]);
    expect(socket('bob').of('dm:created')).toEqual([
      { channel: { id: dmId, type: 'dm', otherUserId: users.alice.id } },
    ]);
    expect(socket('carol').of('dm:created')).toEqual([]);
    expect(mentionsChannel(socket('carol').events, dmId)).toBe(false);
  });
});
