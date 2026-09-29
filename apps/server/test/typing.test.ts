import { TypingPayload, type Ack } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import {
  TYPING_BROADCAST_THROTTLE_MS,
  TYPING_USER_BUCKET_MAX,
  TYPING_USER_BUCKET_WINDOW_MS,
} from '../src/realtime/typing.js';
import { makeApp } from './helpers/app.js';
import { insertUser, login } from './helpers/auth.js';
import { connectRecording, insertChannel, insertDm, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

type Name = 'alice' | 'bob' | 'carol';

let app: FastifyInstance;
let baseUrl: string;
let users: Record<Name, UserRow>;
const cookies: Record<Name, string> = { alice: '', bob: '', carol: '' };
const opened: RecordingClient[] = [];
let general: ChannelRow;

async function setup(timings?: { typingThrottleMs: number }): Promise<void> {
  app = makeApp(timings === undefined ? {} : { timings });
  baseUrl = await listen(app);
  users = {
    alice: await insertUser('alice'),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
  };
  for (const name of ['alice', 'bob', 'carol'] as const) cookies[name] = await login(app, name);
  general = await insertChannel('general');
}

beforeEach(truncateAll);
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

function typingStart(s: RecordingClient, channelId: unknown): Promise<Ack<null>> {
  return new Promise((resolve) => {
    // Deliberately loose payload type: invalid payloads are part of the test.
    s.client.emit('typing:start', { channelId } as { channelId: string }, resolve);
  });
}

function typingFrom(s: RecordingClient, userId: string): TypingPayload[] {
  return s
    .of('typing')
    .map((p) => TypingPayload.parse(p))
    .filter((p) => p.userId === userId);
}

describe('typing:start', () => {
  it('reaches the channel audience except every socket of the sender', async () => {
    await setup();
    const a1 = await connect('alice');
    const a2 = await connect('alice');
    const bob = await connect('bob');
    const carol = await connect('carol');

    expect(await typingStart(a1, general.id)).toEqual({ ok: true, data: null });
    await bob.waitFor('typing');
    await carol.waitFor('typing');
    expect(bob.of('typing')).toEqual([{ channelId: general.id, userId: users.alice.id }]);
    expect(carol.of('typing')).toEqual([{ channelId: general.id, userId: users.alice.id }]);

    // Control: bob types; once alice's sockets have that, alice's own typing would have arrived earlier.
    expect(await typingStart(bob, general.id)).toEqual({ ok: true, data: null });
    await a1.waitFor('typing');
    await a2.waitFor('typing');
    for (const s of [a1, a2]) {
      expect(s.of('typing')).toEqual([{ channelId: general.id, userId: users.bob.id }]);
    }
    // Bob never hears himself either.
    await carol.waitFor('typing', 2);
    expect(typingFrom(bob, users.bob.id)).toEqual([]);
  });

  it('DM typing reaches only the other member', async () => {
    await setup();
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const alice = await connect('alice');
    const bob = await connect('bob');
    const carol = await connect('carol');

    expect(await typingStart(alice, dmId)).toEqual({ ok: true, data: null });
    await bob.waitFor('typing');
    expect(bob.of('typing')).toEqual([{ channelId: dmId, userId: users.alice.id }]);

    // Control in #general reaches carol (and alice); nothing about the DM came before it.
    expect(await typingStart(bob, general.id)).toEqual({ ok: true, data: null });
    await carol.waitFor('typing');
    await alice.waitFor('typing');
    expect(carol.of('typing')).toEqual([{ channelId: general.id, userId: users.bob.id }]);
    expect(alice.of('typing')).toEqual([{ channelId: general.id, userId: users.bob.id }]);
  });

  it('voice → VALIDATION, DM non-member / read-only DM → FORBIDDEN, unknown → NOT_FOUND, bad payload → VALIDATION', async () => {
    await setup();
    const voice = await insertChannel('lounge', { type: 'voice' });
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const gone = await insertUser('gone', { deactivated: true });
    const readOnlyDm = await insertDm(users.carol.id, gone.id);
    const carol = await connect('carol');
    const bob = await connect('bob');

    expect(await typingStart(carol, voice.id)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await typingStart(carol, dmId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await typingStart(carol, readOnlyDm)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await typingStart(carol, '00000000-0000-4000-8000-000000000000')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await typingStart(carol, 'not-a-uuid')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });

    // None of those broadcast anything: control.
    expect(await typingStart(carol, general.id)).toEqual({ ok: true, data: null });
    await bob.waitFor('typing');
    expect(bob.of('typing')).toEqual([{ channelId: general.id, userId: users.carol.id }]);
  });

  it(`the throttle drops repeats within ${TYPING_BROADCAST_THROTTLE_MS} ms (acked ok), per user+channel`, async () => {
    expect(TYPING_BROADCAST_THROTTLE_MS).toBe(2_000);
    await setup();
    const random = await insertChannel('random', { position: 1 });
    const alice = await connect('alice');
    const bob = await connect('bob');
    const carol = await connect('carol');

    const acks = await Promise.all([
      typingStart(alice, general.id),
      typingStart(alice, general.id),
      typingStart(alice, general.id),
    ]);
    expect(acks).toEqual(Array.from({ length: 3 }, () => ({ ok: true, data: null })));
    expect(await typingStart(alice, general.id)).toEqual({ ok: true, data: null });
    // Another channel has its own throttle.
    expect(await typingStart(alice, random.id)).toEqual({ ok: true, data: null });
    // Control: carol's typing reaches bob after everything alice's events would have produced.
    expect(await typingStart(carol, general.id)).toEqual({ ok: true, data: null });
    await waitUntil(() => typingFrom(bob, users.carol.id).length === 1, { message: 'carol typing' });
    expect(typingFrom(bob, users.alice.id)).toEqual([
      { channelId: general.id, userId: users.alice.id },
      { channelId: random.id, userId: users.alice.id },
    ]);
  });

  it(`caps each user at ${TYPING_USER_BUCKET_MAX} events per ${TYPING_USER_BUCKET_WINDOW_MS} ms before touching the DB`, async () => {
    await setup();
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const carol = await connect('carol');
    const bob = await connect('bob');
    const { pool } = testDb();
    const query = vi.spyOn(pool, 'query');
    const randomId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

    // Within the bucket, forbidden and unknown channels are checked against the DB.
    const first: Ack<null>[] = [];
    for (let i = 0; i < TYPING_USER_BUCKET_MAX; i += 1) {
      first.push(await typingStart(carol, i % 2 === 0 ? dmId : randomId(i)));
    }
    expect(first.every((ack) => !ack.ok)).toBe(true);
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(TYPING_USER_BUCKET_MAX);

    // Past it, every event (any channel, even an allowed one) is acked ok, dropped, and never queries.
    query.mockClear();
    const spam = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        typingStart(carol, i === 29 ? general.id : i % 2 === 0 ? dmId : randomId(100 + i)),
      ),
    );
    expect(spam).toEqual(Array.from({ length: 30 }, () => ({ ok: true, data: null })));
    expect(query).not.toHaveBeenCalled();

    // Other users have their own bucket; carol's dropped #general event was never broadcast.
    expect(await typingStart(bob, general.id)).toEqual({ ok: true, data: null });
    await carol.waitFor('typing');
    expect(typingFrom(bob, users.carol.id)).toEqual([]);
    query.mockRestore();
  });

  it('broadcasts again once the throttle window has passed', async () => {
    const throttleMs = 150;
    await setup({ typingThrottleMs: throttleMs });
    const alice = await connect('alice');
    const bob = await connect('bob');

    await typingStart(alice, general.id);
    await typingStart(alice, general.id);
    await bob.waitFor('typing');
    await new Promise((resolve) => setTimeout(resolve, throttleMs + 20));
    await typingStart(alice, general.id);
    await bob.waitFor('typing', 2);
    expect(typingFrom(bob, users.alice.id)).toHaveLength(2);
  });
});
