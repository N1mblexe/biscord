import {
  LIMITS,
  ListMessagesResponse,
  MessageResponse,
  RateLimitedDetails,
  type Message,
} from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, users } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { seedMessages } from '../src/services/messages.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel, insertDm, insertMessage } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

let app: FastifyInstance;
let admin: UserRow;
let alice: UserRow;
let bob: UserRow;
const cookies: Record<string, string> = {};
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  admin = await insertUser('admin', { role: 'admin' });
  alice = await insertUser('alice');
  bob = await insertUser('bob');
  await insertUser('carol');
  for (const name of ['admin', 'alice', 'bob', 'carol']) cookies[name] = await login(app, name);
  general = await insertChannel('general');
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

function cookie(name: string): string {
  const value = cookies[name];
  if (value === undefined) throw new Error(`no cookie for ${name}`);
  return value;
}

const post = (who: string, channelId: string, body: unknown) =>
  api(app, 'POST', `/api/channels/${channelId}/messages`, { cookie: cookie(who), body });
const history = (who: string, channelId: string, query = '') =>
  api(app, 'GET', `/api/channels/${channelId}/messages${query}`, { cookie: cookie(who) });

function sent(res: Awaited<ReturnType<typeof post>>): Message {
  expect(res.statusCode, res.payload).toBe(201);
  return MessageResponse.parse(res.json()).message;
}

function contents(res: Awaited<ReturnType<typeof history>>): string[] {
  expect(res.statusCode, res.payload).toBe(200);
  return ListMessagesResponse.parse(res.json()).messages.map((m) => m.content);
}

describe('channel access', () => {
  it('unknown channel → 404; DM non-member → 403 for history and send', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expectError(await history('alice', unknown), 404, 'NOT_FOUND');
    expectError(await post('alice', unknown, { content: 'hi' }), 404, 'NOT_FOUND');

    const dmId = await insertDm(alice.id, bob.id);
    expectError(await history('carol', dmId), 403, 'FORBIDDEN');
    expectError(await post('carol', dmId, { content: 'hi' }), 403, 'FORBIDDEN');
    // Admins are not DM members either.
    expectError(await history('admin', dmId), 403, 'FORBIDDEN');
    expect(contents(await history('bob', dmId))).toEqual([]);
    sent(await post('bob', dmId, { content: 'hi alice' }));
  });

  it('posting to a voice channel → 400 VALIDATION "Cannot post in a voice channel"', async () => {
    const voice = await insertChannel('lounge', { type: 'voice' });
    const body = expectError(await post('alice', voice.id, { content: 'hi' }), 400, 'VALIDATION');
    expect(body.error.message).toBe('Cannot post in a voice channel');
    expect(contents(await history('alice', voice.id))).toEqual([]);
  });

  it('a DM with a deactivated user is read-only: history yes, send and edit → 403', async () => {
    const dmId = await insertDm(alice.id, bob.id);
    const old = await insertMessage(dmId, alice.id, 'before');
    await testDb().db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, bob.id));
    expect(contents(await history('alice', dmId))).toEqual(['before']);
    expectError(await post('alice', dmId, { content: 'hello?' }), 403, 'FORBIDDEN');
    expectError(
      await api(app, 'PATCH', `/api/messages/${old.id}`, { cookie: cookie('alice'), body: { content: 'x' } }),
      403,
      'FORBIDDEN',
    );
  });

  it('anonymous requests get 401', async () => {
    expectError(await api(app, 'GET', `/api/channels/${general.id}/messages`), 401, 'UNAUTHENTICATED');
    expectError(
      await api(app, 'POST', `/api/channels/${general.id}/messages`, { body: { content: 'x' } }),
      401,
      'UNAUTHENTICATED',
    );
  });
});

describe('POST /api/channels/:id/messages', () => {
  it('trims content, echoes the nonce and returns a staged Message', async () => {
    const message = sent(await post('alice', general.id, { content: '  hello **world**  \n', nonce: 'n-1' }));
    expect(message).toMatchObject({
      channelId: general.id,
      authorId: alice.id,
      content: 'hello **world**',
      editedAt: null,
      attachments: [],
      reactions: [],
      mentionUserIds: [],
      nonce: 'n-1',
    });
    expect(message.id).toMatch(/^[1-9]\d*$/);
    expect(sent(await post('alice', general.id, { content: 'no nonce' })).nonce).toBeNull();
  });

  it('rejects empty, whitespace-only and 4001-character content; accepts exactly 4000', async () => {
    for (const content of ['', '   \n\t ', 'x'.repeat(LIMITS.messageMaxChars + 1)]) {
      expectError(await post('alice', general.id, { content }), 400, 'VALIDATION');
    }
    expectError(await post('alice', general.id, { content: 'x', nonce: 'n'.repeat(65) }), 400, 'VALIDATION');
    const max = sent(await post('alice', general.id, { content: 'y'.repeat(LIMITS.messageMaxChars) }));
    expect(max.content).toHaveLength(LIMITS.messageMaxChars);
    // Surrounding whitespace doesn't count toward the limit.
    sent(await post('alice', general.id, { content: ` ${'z'.repeat(LIMITS.messageMaxChars)} ` }));
  });

  it('attachment ids that are not unattached uploads of the sender → 400 "Unknown attachment", nothing stored', async () => {
    const body = expectError(
      await post('alice', general.id, {
        content: 'see file',
        attachmentIds: ['00000000-0000-4000-8000-000000000000'],
      }),
      400,
      'VALIDATION',
    );
    expect(body.error.message).toBe('Unknown attachment');
    expect(await testDb().db.select().from(messages)).toHaveLength(0);
  });

  it(`the ${LIMITS.rateLimits.messageSend.max + 1}th send within 10 s → 429 RATE_LIMITED, per user`, async () => {
    for (let i = 0; i < LIMITS.rateLimits.messageSend.max; i++) {
      sent(await post('alice', general.id, { content: `m${i}` }));
    }
    const res = await post('alice', general.id, { content: 'one too many' });
    const { retryAfterMs } = RateLimitedDetails.parse(expectError(res, 429, 'RATE_LIMITED').error.details);
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(LIMITS.rateLimits.messageSend.windowMs);
    // Keyed on the user, not the IP: another user from the same address can still send.
    sent(await post('bob', general.id, { content: 'bob is fine' }));
    // Reads are not limited.
    expect(contents(await history('alice', general.id))).toHaveLength(LIMITS.rateLimits.messageSend.max + 1);
  });
});

describe('GET /api/channels/:id/messages', () => {
  beforeEach(async () => {
    await seedMessages(testDb().db, { channelId: general.id, authorId: alice.id, count: 120, prefix: 'm' });
    // Noise in another channel must never leak into this one.
    const other = await insertChannel('other', { position: 1 });
    await seedMessages(testDb().db, { channelId: other.id, authorId: bob.id, count: 5, prefix: 'other' });
  });

  const range = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `m ${from + i}`);

  async function idOf(content: string): Promise<string> {
    const [row] = await testDb().db.select().from(messages).where(eq(messages.content, content));
    if (row === undefined) throw new Error(`no message ${content}`);
    return String(row.id);
  }

  it('latest page: the newest 50, ascending', async () => {
    expect(contents(await history('bob', general.id))).toEqual(range(71, 120));
  });

  it('before pages backwards to the start; a short page means nothing older', async () => {
    const page2 = contents(await history('bob', general.id, `?before=${await idOf('m 71')}`));
    expect(page2).toEqual(range(21, 70));
    const page3 = contents(await history('bob', general.id, `?before=${await idOf('m 21')}`));
    expect(page3).toEqual(range(1, 20));
    expect(contents(await history('bob', general.id, `?before=${await idOf('m 1')}`))).toEqual([]);
  });

  it('after pages forwards (ascending) until a short page', async () => {
    expect(contents(await history('bob', general.id, `?after=${await idOf('m 10')}&limit=5`))).toEqual(
      range(11, 15),
    );
    expect(contents(await history('bob', general.id, `?after=${await idOf('m 100')}`))).toEqual(
      range(101, 120),
    );
    expect(contents(await history('bob', general.id, `?after=${await idOf('m 120')}`))).toEqual([]);
  });

  it('limit: 1 and 100 are allowed; 0, 101, non-numbers and before+after are VALIDATION', async () => {
    expect(contents(await history('bob', general.id, '?limit=1'))).toEqual(['m 120']);
    expect(contents(await history('bob', general.id, '?limit=100'))).toEqual(range(21, 120));
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?before=1&after=2',
      '?before=0',
      '?after=-1',
    ]) {
      expectError(await history('bob', general.id, query), 400, 'VALIDATION');
    }
  });

  it('ids beyond the table and up to 16 digits are handled without precision loss', async () => {
    expect(contents(await history('bob', general.id, '?before=9999999999999999&limit=2'))).toEqual([
      'm 119',
      'm 120',
    ]);
    expect(contents(await history('bob', general.id, '?after=9999999999999999'))).toEqual([]);
  });
});

describe('PATCH /api/messages/:id', () => {
  it('only the author can edit; it trims, sets editedAt and keeps the nonce', async () => {
    const original = sent(await post('alice', general.id, { content: 'first', nonce: 'abc' }));
    const url = `/api/messages/${original.id}`;
    expectError(
      await api(app, 'PATCH', url, { cookie: cookie('bob'), body: { content: 'hijack' } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await api(app, 'PATCH', url, { cookie: cookie('admin'), body: { content: 'admin' } }),
      403,
      'FORBIDDEN',
    );

    const res = await api(app, 'PATCH', url, { cookie: cookie('alice'), body: { content: '  second  ' } });
    expect(res.statusCode, res.payload).toBe(200);
    const edited = MessageResponse.parse(res.json()).message;
    expect(edited).toMatchObject({
      id: original.id,
      content: 'second',
      nonce: 'abc',
      createdAt: original.createdAt,
    });
    expect(edited.editedAt).not.toBeNull();
  });

  it("can't leave a message without attachments empty; unknown / malformed ids", async () => {
    const original = sent(await post('alice', general.id, { content: 'keep me' }));
    for (const content of ['', '    ']) {
      expectError(
        await api(app, 'PATCH', `/api/messages/${original.id}`, {
          cookie: cookie('alice'),
          body: { content },
        }),
        400,
        'VALIDATION',
      );
    }
    const [row] = await testDb().db.select().from(messages);
    expect(row).toMatchObject({ content: 'keep me', editedAt: null });
    expectError(
      await api(app, 'PATCH', '/api/messages/999999', { cookie: cookie('alice'), body: { content: 'x' } }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await api(app, 'PATCH', '/api/messages/0', { cookie: cookie('alice'), body: { content: 'x' } }),
      400,
      'VALIDATION',
    );
  });
});

describe('DELETE /api/messages/:id', () => {
  const del = (who: string, id: string | number) =>
    api(app, 'DELETE', `/api/messages/${id}`, { cookie: cookie(who) });

  async function remaining(): Promise<number> {
    return (await testDb().db.select().from(messages)).length;
  }

  it('the author can delete; another member cannot', async () => {
    const mine = await insertMessage(general.id, alice.id);
    expectError(await del('bob', mine.id), 403, 'FORBIDDEN');
    expect((await del('alice', mine.id)).statusCode).toBe(204);
    expect(await remaining()).toBe(0);
    expectError(await del('alice', mine.id), 404, 'NOT_FOUND');
  });

  it("an admin can delete anyone's message in a text channel", async () => {
    const theirs = await insertMessage(general.id, alice.id);
    expect((await del('admin', theirs.id)).statusCode).toBe(204);
    expect(await remaining()).toBe(0);
  });

  it("an admin can't delete the other member's message in a DM (even as a member); the author can", async () => {
    const dmId = await insertDm(admin.id, bob.id);
    const bobs = await insertMessage(dmId, bob.id, 'private');
    expectError(await del('admin', bobs.id), 403, 'FORBIDDEN');
    // Non-members get the access error.
    expectError(await del('carol', bobs.id), 403, 'FORBIDDEN');
    expect(await remaining()).toBe(1);
    expect((await del('bob', bobs.id)).statusCode).toBe(204);
    expect(await remaining()).toBe(0);
  });

  it('non-members of a DM cannot edit its messages either', async () => {
    const dmId = await insertDm(alice.id, bob.id);
    const msg = await insertMessage(dmId, alice.id);
    expectError(
      await api(app, 'PATCH', `/api/messages/${msg.id}`, { cookie: cookie('carol'), body: { content: 'x' } }),
      403,
      'FORBIDDEN',
    );
  });
});
