import { ListMessagesResponse, MessageEventPayload, MessageResponse, type Message } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messageMentions } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { parseMentionUsernames } from '../src/services/mentions.js';
import { makeApp } from './helpers/app.js';
import { api, insertUser, login } from './helpers/auth.js';
import { connectRecording, insertChannel, insertDm, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

describe('parseMentionUsernames', () => {
  it.each([
    ['@bob', ['bob']],
    ['hi @bob!', ['bob']],
    ['(@bob), @carol.', ['bob', 'carol']],
    ['a@bob', []],
    ['mail bob@example.com', []],
    ['@@bob', []],
    ['@BOB and @Bob and @bob', ['bob']],
    ['@bo', []],
    ['@bob_2 @carol', ['bob_2', 'carol']],
    ['_@bob', []],
    ['@', []],
    ['line\n@bob', ['bob']],
  ])('%j → %j', (content, expected) => {
    expect(parseMentionUsernames(content)).toEqual(expected);
  });
});

let app: FastifyInstance;
let alice: UserRow;
let bob: UserRow;
let carol: UserRow;
let general: ChannelRow;
const cookies: Record<string, string> = {};

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  alice = await insertUser('alice');
  bob = await insertUser('bob');
  carol = await insertUser('carol');
  await insertUser('gone', { deactivated: true });
  for (const name of ['alice', 'bob', 'carol']) cookies[name] = await login(app, name);
  general = await insertChannel('general');
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

async function send(who: string, channelId: string, content: string): Promise<Message> {
  const res = await api(app, 'POST', `/api/channels/${channelId}/messages`, {
    cookie: cookies[who],
    body: { content },
  });
  expect(res.statusCode, res.payload).toBe(201);
  return MessageResponse.parse(res.json()).message;
}

async function edit(who: string, id: string, content: string): Promise<Message> {
  const res = await api(app, 'PATCH', `/api/messages/${id}`, { cookie: cookies[who], body: { content } });
  expect(res.statusCode, res.payload).toBe(200);
  return MessageResponse.parse(res.json()).message;
}

async function storedMentions(messageId: string): Promise<string[]> {
  const rows = await testDb()
    .db.select()
    .from(messageMentions)
    .where(eq(messageMentions.messageId, Number(messageId)));
  return rows.map((r) => r.userId).sort();
}

const sorted = (...ids: string[]): string[] => [...ids].sort();

describe('mentions on send', () => {
  it('only active, known users; never self; case-insensitive and de-duplicated', async () => {
    const message = await send(
      'alice',
      general.id,
      'hi @BOB @bob @Carol @nobody @gone @alice a@bob @@carol x@carol',
    );
    expect(message.mentionUserIds).toEqual(sorted(bob.id, carol.id));
    expect(await storedMentions(message.id)).toEqual(sorted(bob.id, carol.id));
  });

  it.each([
    ['a@bob', []],
    ['@@bob', []],
    ['@nobody', []],
    ['@gone', []],
    ['@alice (self)', []],
    ['@BoB', ['bob']],
  ])('%j', async (content, expected) => {
    const message = await send('alice', general.id, content);
    expect(message.mentionUserIds).toEqual(expected.map(() => bob.id));
    expect(await storedMentions(message.id)).toEqual(message.mentionUserIds);
  });

  it('a DM always mentions the other member, and only them (a non-member @carol is ignored)', async () => {
    const dmId = await insertDm(alice.id, bob.id);
    expect((await send('alice', dmId, 'plain')).mentionUserIds).toEqual([bob.id]);
    const withCarol = await send('alice', dmId, 'hey @carol and @bob and @alice');
    expect(withCarol.mentionUserIds).toEqual([bob.id]);
    expect(await storedMentions(withCarol.id)).toEqual([bob.id]);
    expect((await send('bob', dmId, 'reply')).mentionUserIds).toEqual([alice.id]);
  });

  it('message:created carries mentionUserIds to the audience', async () => {
    const baseUrl = await listen(app);
    const observer: RecordingClient = await connectRecording(baseUrl, cookies.bob ?? '', {
      ignore: ['presence'],
    });
    try {
      const message = await send('alice', general.id, '@bob look');
      await observer.waitFor('message:created');
      expect(MessageEventPayload.parse(observer.of('message:created')[0]).message.mentionUserIds).toEqual([
        bob.id,
      ]);
      expect(message.mentionUserIds).toEqual([bob.id]);
    } finally {
      observer.client.disconnect();
    }
  });
});

describe('mentions on edit', () => {
  it('editing recomputes the mentions (response, stored rows and history)', async () => {
    const message = await send('alice', general.id, 'hey @bob');
    expect(message.mentionUserIds).toEqual([bob.id]);

    const edited = await edit('alice', message.id, 'actually @carol and @CAROL');
    expect(edited.mentionUserIds).toEqual([carol.id]);
    expect(await storedMentions(message.id)).toEqual([carol.id]);

    const cleared = await edit('alice', message.id, 'nobody');
    expect(cleared.mentionUserIds).toEqual([]);
    expect(await storedMentions(message.id)).toEqual([]);

    const res = await api(app, 'GET', `/api/channels/${general.id}/messages`, { cookie: cookies.bob });
    expect(ListMessagesResponse.parse(res.json()).messages[0]?.mentionUserIds).toEqual([]);
  });

  it('a DM edit keeps mentioning the other member', async () => {
    const dmId = await insertDm(alice.id, bob.id);
    const message = await send('alice', dmId, 'hi');
    expect((await edit('alice', message.id, 'hi @carol')).mentionUserIds).toEqual([bob.id]);
    expect(await storedMentions(message.id)).toEqual([bob.id]);
  });
});
