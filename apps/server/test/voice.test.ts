import { randomUUID } from 'node:crypto';
import {
  BootstrapResponse,
  LIMITS,
  VoiceTokenResponse,
  voiceRoomName,
  type Ack,
  type VoiceParticipant,
  type VoiceStatePayload,
} from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channels, users as usersTable } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { VOICE_TOKEN_RATE_LIMIT } from '../src/plugins/rate-limit.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { connectRecording, insertChannel, insertDm, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import {
  FakeVoiceBackend,
  notFound,
  postWebhook,
  TEST_LK_KEY,
  TEST_LK_SECRET,
  unavailable,
  webhookBody,
  type WebhookInput,
} from './helpers/voice.js';
import { waitUntil } from './helpers/wait.js';

type Name = 'alice' | 'bob' | 'carol';

const TOKEN = 'unit-test-token';

let app: FastifyInstance;
let backend: FakeVoiceBackend;
let baseUrl: string;
let users: Record<Name, UserRow>;
const cookies: Record<Name, string> = { alice: '', bob: '', carol: '' };
const opened: RecordingClient[] = [];
let lounge: ChannelRow;
let games: ChannelRow;
let general: ChannelRow;

async function setup(env: NodeJS.ProcessEnv = {}): Promise<void> {
  backend = new FakeVoiceBackend();
  app = makeApp({
    env: testEnv({ HEARTH_TEST_MODE: 'true', HEARTH_TEST_TOKEN: TOKEN, ...env }),
    voiceBackend: backend,
  });
  baseUrl = await listen(app);
  // Let the boot reconcile finish, then forget its calls.
  await app.voice.reconciler.runNow();
  backend.calls.length = 0;
  users = {
    alice: await insertUser('alice', { role: 'admin' }),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
  };
  for (const name of ['alice', 'bob', 'carol'] as const) cookies[name] = await login(app, name);
  lounge = await insertChannel('lounge', { type: 'voice', position: 0 });
  games = await insertChannel('games', { type: 'voice', position: 1 });
  general = await insertChannel('general', { position: 2 });
}

beforeEach(async () => {
  await truncateAll();
  await setup();
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

async function voiceOf(name: Name = 'carol'): Promise<Record<string, VoiceParticipant[]>> {
  const res = await api(app, 'GET', '/api/bootstrap', { cookie: cookies[name] });
  expect(res.statusCode, res.payload).toBe(200);
  return BootstrapResponse.parse(res.json()).voice;
}

/** User ids per channel, from bootstrap. */
async function members(): Promise<Record<string, string[]>> {
  const voice = await voiceOf();
  return Object.fromEntries(Object.entries(voice).map(([id, list]) => [id, list.map((p) => p.userId)]));
}

async function hook(input: WebhookInput): Promise<void> {
  const res = await postWebhook(app, input);
  expect(res.statusCode, res.payload).toBe(200);
}

const join = (channel: ChannelRow, name: Name, sid: string, extra: Partial<WebhookInput> = {}) =>
  hook({ event: 'participant_joined', channelId: channel.id, userId: users[name].id, sid, ...extra });
const leave = (channel: ChannelRow, name: Name, sid: string, extra: Partial<WebhookInput> = {}) =>
  hook({ event: 'participant_left', channelId: channel.id, userId: users[name].id, sid, ...extra });

function sendVoiceState(s: RecordingClient, payload: VoiceStatePayload): Promise<Ack<null>> {
  return new Promise((resolve) => {
    s.client.emit('voice:state', payload, resolve);
  });
}

const flags = { selfMute: false, selfDeaf: false, camera: false, screen: false };

describe('POST /api/voice/:channelId/token', () => {
  it('mints a B.6 token: identity, name, room, TTL 600 s, exact grants', async () => {
    await api(app, 'PATCH', '/api/me', { cookie: cookies.bob, body: { displayName: 'Bobby' } });
    const res = await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.bob });
    expect(res.statusCode, res.payload).toBe(200);
    const body = VoiceTokenResponse.parse(res.json());
    expect(body.url).toBe('ws://localhost:7880');
    expect(body.roomName).toBe(`voice_${lounge.id}`);

    const claims = await new TokenVerifier(TEST_LK_KEY, TEST_LK_SECRET).verify(body.token);
    expect(claims.sub).toBe(users.bob.id);
    expect(claims.name).toBe('Bobby');
    expect(claims.iss).toBe(TEST_LK_KEY);
    expect(claims.exp).toBeDefined();
    expect(claims.nbf).toBeDefined();
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(LIMITS.livekitTokenTtlSeconds);
    expect(LIMITS.livekitTokenTtlSeconds).toBe(600);
    expect(body.expiresAt).toBe(new Date((claims.exp ?? 0) * 1000).toISOString());
    expect(claims.video).toEqual({
      roomJoin: true,
      room: `voice_${lounge.id}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'],
      roomAdmin: false,
      roomCreate: false,
    });
    // Admins get exactly the same grants; minting never calls LiveKit.
    const admin = await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.alice });
    const adminClaims = await new TokenVerifier(TEST_LK_KEY, TEST_LK_SECRET).verify(
      VoiceTokenResponse.parse(admin.json()).token,
    );
    expect(adminClaims.video).toEqual(claims.video);
    expect(backend.calls).toEqual([]);
  });

  it('text channel, DM or unknown id → 404; malformed id → 400', async () => {
    const dm = await insertDm(users.alice.id, users.bob.id);
    for (const id of [general.id, dm, randomUUID()]) {
      expectError(
        await api(app, 'POST', `/api/voice/${id}/token`, { cookie: cookies.alice }),
        404,
        'NOT_FOUND',
      );
    }
    expectError(
      await api(app, 'POST', '/api/voice/nope/token', { cookie: cookies.alice }),
      400,
      'VALIDATION',
    );
  });

  it('anonymous or deactivated → 401', async () => {
    expectError(await api(app, 'POST', `/api/voice/${lounge.id}/token`), 401, 'UNAUTHENTICATED');
    await testDb()
      .db.update(usersTable)
      .set({ deactivatedAt: new Date() })
      .where(eq(usersTable.id, users.bob.id));
    expectError(
      await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.bob }),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('503 LIVEKIT_UNAVAILABLE only while the cached health says LiveKit is down', async () => {
    // A reconcile pass that can't reach LiveKit records "down" in the health cache.
    backend.fail.listRooms = [unavailable()];
    await app.voice.reconciler.runNow();
    expect((await api(app, 'GET', '/api/health')).json()).toMatchObject({ livekit: 'down' });
    expectError(
      await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.bob }),
      503,
      'LIVEKIT_UNAVAILABLE',
    );
  });

  it('is rate limited to 30 per minute per user', async () => {
    for (let i = 0; i < VOICE_TOKEN_RATE_LIMIT.max; i += 1) {
      const res = await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.bob });
      expect(res.statusCode).toBe(200);
    }
    expectError(
      await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.bob }),
      429,
      'RATE_LIMITED',
    );
    // Per user: carol is unaffected.
    expect(
      (await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: cookies.carol })).statusCode,
    ).toBe(200);
    expect(VOICE_TOKEN_RATE_LIMIT).toEqual({ max: 30, windowMs: 60_000 });
  });
});

describe('POST /api/livekit/webhook', () => {
  it('a validly signed participant_joined → voice:joined to all and /bootstrap.voice', async () => {
    const carol = await connect('carol');
    const joinedAtMs = Date.UTC(2026, 8, 29, 12, 0, 0, 123);
    await join(lounge, 'alice', 'PA_a1', { joinedAtMs });
    await carol.waitFor('voice:joined');
    const participant = { userId: users.alice.id, joinedAt: new Date(joinedAtMs).toISOString(), ...flags };
    expect(carol.of('voice:joined')).toEqual([{ channelId: lounge.id, participant }]);
    expect(await voiceOf()).toEqual({ [lounge.id]: [participant] });
  });

  it('a wrong key, a tampered body or no Authorization → 401 and no change', async () => {
    const input: WebhookInput = {
      event: 'participant_joined',
      channelId: lounge.id,
      userId: users.alice.id,
      sid: 'PA_a1',
    };
    expectError(
      await postWebhook(app, input, { secret: 'another-secret-0123456789abcdef-xyz' }),
      401,
      'UNAUTHENTICATED',
    );
    expectError(
      await postWebhook(app, input, { tamper: (body) => body.replace(users.alice.id, users.bob.id) }),
      401,
      'UNAUTHENTICATED',
    );
    expectError(await postWebhook(app, input, { tamper: (body) => `${body} ` }), 401, 'UNAUTHENTICATED');
    expectError(await postWebhook(app, input, { authorization: null }), 401, 'UNAUTHENTICATED');
    expectError(await postWebhook(app, input, { authorization: 'garbage' }), 401, 'UNAUTHENTICATED');
    expect(await voiceOf()).toEqual({});
  });

  it('only application/webhook+json is accepted: application/json or text/plain → 415, even if signed', async () => {
    const input: WebhookInput = {
      event: 'participant_joined',
      channelId: lounge.id,
      userId: users.alice.id,
      sid: 'PA_a1',
    };
    for (const contentType of ['application/json', 'text/plain', 'text/plain; charset=utf-8']) {
      expectError(await postWebhook(app, input, { contentType }), 415, 'UNSUPPORTED_MEDIA');
    }
    expect(await voiceOf()).toEqual({});
    const ok = await postWebhook(app, input, { contentType: 'application/webhook+json' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
  });

  it('a repeated event id is a no-op', async () => {
    await join(lounge, 'alice', 'PA_a1');
    const finished = webhookBody({ event: 'room_finished', channelId: lounge.id, id: 'EV_finish' });
    expect((await postWebhook(app, finished)).statusCode).toBe(200);
    expect(await members()).toEqual({});
    await join(lounge, 'bob', 'PA_b1');
    // LiveKit redelivers the same room_finished: it must not clear bob.
    expect((await postWebhook(app, finished)).statusCode).toBe(200);
    expect(await members()).toEqual({ [lounge.id]: [users.bob.id] });
  });

  it('participants are keyed by sid: a stale participant_left never removes a newer connection', async () => {
    const carol = await connect('carol');
    await join(lounge, 'alice', 'PA_old');
    await join(lounge, 'alice', 'PA_new'); // reconnect / second device: same membership
    await leave(lounge, 'alice', 'PA_old'); // LiveKit dropped the older connection
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
    // A late duplicate join for the dropped sid is stale too.
    await join(lounge, 'alice', 'PA_old');
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
    await leave(lounge, 'alice', 'PA_new');
    expect(await members()).toEqual({});
    await carol.waitFor('voice:left');
    expect(carol.of('voice:joined')).toHaveLength(1);
    expect(carol.of('voice:left')).toEqual([{ channelId: lounge.id, userId: users.alice.id }]);
  });

  it('an out-of-order older join in the same room is stale: its participant_left keeps the live one', async () => {
    const carol = await connect('carol');
    const now = Date.now();
    await join(lounge, 'alice', 'PA_new', { joinedAtMs: now });
    await join(lounge, 'alice', 'PA_old', { joinedAtMs: now - 5_000 }); // delivered late
    await leave(lounge, 'alice', 'PA_old'); // LiveKit dropped the older connection
    expect((await voiceOf())[lounge.id]).toEqual([
      { userId: users.alice.id, joinedAt: new Date(now).toISOString(), ...flags },
    ]);
    // No kick: removeParticipant targets the identity and would drop the live connection.
    expect(backend.callsOf('removeParticipant')).toEqual([]);
    // Reconcile agrees with LiveKit (which lists PA_new); PA_new is still the tracked connection.
    backend.put(lounge.id, users.alice.id, 'PA_new', now);
    await app.voice.reconciler.runNow();
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
    await leave(lounge, 'alice', 'PA_new');
    expect(await members()).toEqual({});
    await carol.waitFor('voice:left');
    expect(carol.events.map((e) => e.event)).toEqual(['voice:joined', 'voice:left']);
  });

  it('participant_connection_aborted counts as left', async () => {
    await join(lounge, 'alice', 'PA_a1');
    await hook({
      event: 'participant_connection_aborted',
      channelId: lounge.id,
      userId: users.alice.id,
      sid: 'PA_a1',
    });
    expect(await members()).toEqual({});
  });

  it('rooms that are not a voice channel of this DB are ignored', async () => {
    const carol = await connect('carol');
    const foreign = randomUUID(); // e.g. a channel of the e2e server's DB on the shared container
    await hook({ event: 'participant_joined', channelId: foreign, userId: users.alice.id, sid: 'PA_1' });
    await hook({ event: 'participant_joined', channelId: general.id, userId: users.alice.id, sid: 'PA_2' });
    await hook({ event: 'participant_joined', roomName: 'lobby', userId: users.alice.id, sid: 'PA_3' });
    await hook({ event: 'room_finished', channelId: foreign });
    // Unhandled event types and non-Hearth identities are ignored as well.
    await hook({ event: 'track_published', channelId: lounge.id, userId: users.alice.id, sid: 'PA_4' });
    await hook({ event: 'participant_joined', channelId: lounge.id, userId: 'egress-bot', sid: 'PA_5' });
    expect(await members()).toEqual({});
    // Control: a real join is seen, and it is the only voice event.
    await join(lounge, 'bob', 'PA_b1');
    await carol.waitFor('voice:joined');
    expect(carol.events.map((e) => e.event)).toEqual(['voice:joined']);
    // A foreign room with the same user doesn't move bob or trigger removeParticipant.
    await hook({ event: 'participant_joined', channelId: foreign, userId: users.bob.id, sid: 'PA_b2' });
    expect(await members()).toEqual({ [lounge.id]: [users.bob.id] });
    expect(backend.callsOf('removeParticipant')).toEqual([]);
  });

  it('room_finished clears the room', async () => {
    const carol = await connect('carol');
    await join(lounge, 'alice', 'PA_a1');
    await join(lounge, 'bob', 'PA_b1');
    await join(games, 'carol', 'PA_c1');
    await hook({ event: 'room_finished', channelId: lounge.id });
    await carol.waitFor('voice:left', 2);
    expect(carol.of('voice:left')).toEqual([
      { channelId: lounge.id, userId: users.alice.id },
      { channelId: lounge.id, userId: users.bob.id },
    ]);
    expect(await members()).toEqual({ [games.id]: [users.carol.id] });
  });

  it('a join to a second room removes the user from the first (removeParticipant; 404 ok)', async () => {
    const carol = await connect('carol');
    backend.put(lounge.id, users.alice.id, 'PA_a1');
    await join(lounge, 'alice', 'PA_a1', { joinedAtMs: Date.now() - 1000 });
    await join(games, 'alice', 'PA_a2');
    await waitUntil(() => backend.callsOf('removeParticipant').length === 1);
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(lounge.id), identity: users.alice.id },
    ]);
    await carol.waitFor('voice:joined', 2);
    expect(carol.events.map((e) => [e.event, (e.payload as { channelId: string }).channelId])).toEqual([
      ['voice:joined', lounge.id],
      ['voice:left', lounge.id],
      ['voice:joined', games.id],
    ]);
    expect(await members()).toEqual({ [games.id]: [users.alice.id] });
    // The old room's participant_left arrives afterwards: stale, nothing changes.
    await leave(lounge, 'alice', 'PA_a1');
    expect(await members()).toEqual({ [games.id]: [users.alice.id] });

    // Moving again when LiveKit no longer has the old participant: the 404 is fine.
    await join(lounge, 'alice', 'PA_a3');
    await waitUntil(() => backend.callsOf('removeParticipant').length === 2);
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
  });

  it('an out-of-order older join does not pull the user back; it is removed from that room instead', async () => {
    const now = Date.now();
    await join(games, 'alice', 'PA_new', { joinedAtMs: now });
    await join(lounge, 'alice', 'PA_old', { joinedAtMs: now - 5_000 });
    expect(await members()).toEqual({ [games.id]: [users.alice.id] });
    await waitUntil(() => backend.callsOf('removeParticipant').length === 1);
    expect(backend.callsOf('removeParticipant')[0]?.room).toBe(voiceRoomName(lounge.id));
  });

  it('a kick for the old room is skipped if the user re-joined it before the kick runs (A→B→A)', async () => {
    const voice = app.voice.state;
    const alice = users.alice.id;
    const now = Date.now();
    backend.put(lounge.id, alice, 'PA_a2', now + 2);
    // A → B → A, all applied before the queued kicks run (their webhooks were already waiting).
    await voice.exclusive(() => {
      voice.participantJoined(lounge.id, { userId: alice, sid: 'PA_a1', joinedAt: new Date(now) });
      voice.participantJoined(games.id, { userId: alice, sid: 'PA_b1', joinedAt: new Date(now + 1) });
      voice.participantJoined(lounge.id, { userId: alice, sid: 'PA_a2', joinedAt: new Date(now + 2) });
    });
    await voice.exclusive(() => undefined); // the kicks queued behind it have run
    // Only games is kicked: removeParticipant(lounge, alice) would have dropped the live re-join PA_a2.
    await waitUntil(() => backend.callsOf('removeParticipant').length === 1);
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(games.id), identity: alice },
    ]);
    expect(backend.rooms.get(voiceRoomName(lounge.id))).toMatchObject([{ sid: 'PA_a2' }]);
    expect(await members()).toEqual({ [lounge.id]: [alice] });
  });
});

describe('voice:state', () => {
  it('outside the channel → ack VALIDATION; inside → voice:updated to all', async () => {
    const alice = await connect('alice');
    const carol = await connect('carol');
    const muted = { channelId: lounge.id, ...flags, selfMute: true };
    expect(await sendVoiceState(alice, muted)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await sendVoiceState(alice, { ...muted, channelId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    // Bad payload.
    expect(await sendVoiceState(alice, { channelId: lounge.id } as VoiceStatePayload)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });

    await join(lounge, 'alice', 'PA_a1');
    const state = { channelId: lounge.id, selfMute: true, selfDeaf: true, camera: false, screen: true };
    expect(await sendVoiceState(alice, state)).toEqual({ ok: true, data: null });
    await carol.waitFor('voice:updated');
    await alice.waitFor('voice:updated');
    const [updated] = carol.of('voice:updated');
    expect(updated).toMatchObject({
      channelId: lounge.id,
      participant: { userId: users.alice.id, selfMute: true, selfDeaf: true, camera: false, screen: true },
    });
    expect((await voiceOf())[lounge.id]).toEqual([
      (updated as { participant: VoiceParticipant }).participant,
    ]);
    // In the channel, but the event names another one → VALIDATION.
    expect(await sendVoiceState(alice, { ...state, channelId: games.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('a state sent before the join webhook arrives becomes the initial flags', async () => {
    const alice = await connect('alice');
    const carol = await connect('carol');
    await sendVoiceState(alice, { channelId: lounge.id, ...flags, selfMute: true });
    await join(lounge, 'alice', 'PA_a1');
    await carol.waitFor('voice:joined');
    expect(carol.of('voice:joined')).toMatchObject([{ participant: { selfMute: true, selfDeaf: false } }]);
    // After leaving, the stored state is gone.
    await leave(lounge, 'alice', 'PA_a1');
    await join(lounge, 'alice', 'PA_a2');
    expect((await voiceOf())[lounge.id]).toMatchObject([{ selfMute: false }]);
  });
});

describe('reconcile', () => {
  it('corrects memory in both directions, emitting the differences; bootstrap matches memory', async () => {
    const carol = await connect('carol');
    await join(lounge, 'alice', 'PA_a1'); // memory only: LiveKit never had her (missed participant_left)
    await join(games, 'carol', 'PA_c1');
    backend.put(games.id, users.carol.id, 'PA_c1');
    backend.put(lounge.id, users.bob.id, 'PA_b1', Date.UTC(2026, 0, 1)); // missed participant_joined
    const foreign = randomUUID();
    backend.put(foreign, users.bob.id, 'PA_x'); // another DB's room: never listed or touched
    await carol.waitFor('voice:joined', 2);
    carol.events.length = 0;

    await app.voice.reconciler.runNow();
    await carol.waitFor('voice:joined');
    expect(carol.events).toEqual([
      { event: 'voice:left', payload: { channelId: lounge.id, userId: users.alice.id } },
      {
        event: 'voice:joined',
        payload: {
          channelId: lounge.id,
          participant: {
            userId: users.bob.id,
            joinedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
            ...flags,
          },
        },
      },
    ]);
    expect(await members()).toEqual({ [lounge.id]: [users.bob.id], [games.id]: [users.carol.id] });
    expect(backend.callsOf('listParticipants').map((c) => c.room)).not.toContain(voiceRoomName(foreign));
    expect(backend.calls.some((c) => 'room' in c && c.room === voiceRoomName(foreign))).toBe(false);
    expect(backend.callsOf('removeParticipant')).toEqual([]);

    // A second pass with nothing changed emits nothing.
    carol.events.length = 0;
    await app.voice.reconciler.runNow();
    await join(lounge, 'carol', 'PA_c2'); // control event (moves carol; LiveKit still has her in games)
    await carol.waitFor('voice:joined');
    expect(carol.events.map((e) => e.event)).toEqual(['voice:left', 'voice:joined']);
  });

  it('a user LiveKit reports in two rooms keeps the newest and is removed from the other', async () => {
    backend.put(lounge.id, users.alice.id, 'PA_old', Date.now() - 10_000);
    backend.put(games.id, users.alice.id, 'PA_new', Date.now());
    await app.voice.reconciler.runNow();
    expect(await members()).toEqual({ [games.id]: [users.alice.id] });
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(lounge.id), identity: users.alice.id },
    ]);
  });

  it('memberships changed while LiveKit is being listed are left alone', async () => {
    backend.put(lounge.id, users.bob.id, 'PA_b1');
    let injected = false;
    backend.onCall = async (call) => {
      if (call.op !== 'listParticipants' || injected) return;
      injected = true;
      // Arrive mid-pass: carol joins (LiveKit's listing doesn't have her yet), bob leaves.
      await join(games, 'carol', 'PA_c1');
      await leave(lounge, 'bob', 'PA_b1');
    };
    await app.voice.reconciler.runNow();
    expect(injected).toBe(true);
    // Neither carol's newer join is undone nor bob's (already gone) sid re-added.
    expect(await members()).toEqual({ [games.id]: [users.carol.id] });
  });

  it('a connection LiveKit lists wins over a tombstone older than the pass', async () => {
    const carol = await connect('carol');
    await join(lounge, 'alice', 'PA_a1');
    await leave(lounge, 'alice', 'PA_a1'); // e.g. a wrongly ordered or bogus left: PA_a1 is tombstoned
    expect(await members()).toEqual({});
    backend.put(lounge.id, users.alice.id, 'PA_a1'); // ...but LiveKit still has that connection
    await app.voice.reconciler.runNow();
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
    await carol.waitFor('voice:joined', 2);
    // It is tracked as live again: its participant_left removes her.
    await leave(lounge, 'alice', 'PA_a1');
    expect(await members()).toEqual({});
  });

  it('a failed listRooms changes nothing; passes never overlap', async () => {
    await join(lounge, 'alice', 'PA_a1');
    backend.fail.listRooms = [unavailable()];
    await app.voice.reconciler.runNow();
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });
    // A failed listParticipants aborts the pass too.
    backend.put(lounge.id, users.bob.id, 'PA_b1');
    backend.fail.listParticipants = [unavailable()];
    await app.voice.reconciler.runNow();
    expect(await members()).toEqual({ [lounge.id]: [users.alice.id] });

    let active = 0;
    let maxActive = 0;
    backend.onCall = async (call) => {
      if (call.op !== 'listRooms') return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };
    await Promise.all([
      app.voice.reconciler.runNow(),
      app.voice.reconciler.runNow(),
      app.voice.reconciler.runNow(),
    ]);
    expect(maxActive).toBe(1);
    expect(await members()).toEqual({ [lounge.id]: [users.bob.id] });
  });

  it('runs at boot and every VOICE_RECONCILE_MS', async () => {
    await app.close();
    await truncateAll();
    await setup({ VOICE_RECONCILE_MS: '1000' });
    backend.put(lounge.id, users.bob.id, 'PA_b1');
    await waitUntil(async () => (await members())[lounge.id]?.[0] === users.bob.id, {
      timeoutMs: 3_000,
      message: 'periodic reconcile',
    });
  });
});

describe('voice channel delete', () => {
  it('calls deleteRoom before the DB delete, then clears the voice state and broadcasts', async () => {
    const carol = await connect('carol');
    backend.put(lounge.id, users.bob.id, 'PA_b1');
    await join(lounge, 'bob', 'PA_b1');
    let existedDuringDeleteRoom: boolean | null = null;
    backend.onCall = async (call) => {
      if (call.op !== 'deleteRoom') return;
      const rows = await testDb().db.select().from(channels).where(eq(channels.id, lounge.id));
      existedDuringDeleteRoom = rows.length === 1;
    };
    const res = await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice });
    expect(res.statusCode, res.payload).toBe(204);
    expect(backend.callsOf('deleteRoom')).toEqual([{ op: 'deleteRoom', room: voiceRoomName(lounge.id) }]);
    expect(existedDuringDeleteRoom).toBe(true);
    expect(await testDb().db.select().from(channels).where(eq(channels.id, lounge.id))).toEqual([]);
    expect(await voiceOf()).toEqual({});
    await carol.waitFor('channel:deleted');
    expect(carol.events.map((e) => e.event)).toEqual(['voice:joined', 'channel:deleted']);
    // LiveKit's participant_left for the deleted room is now foreign and ignored.
    await leave(lounge, 'bob', 'PA_b1');
  });

  it('a LiveKit error → 503 LIVEKIT_UNAVAILABLE, the channel and its voice state are kept', async () => {
    await join(lounge, 'bob', 'PA_b1');
    backend.fail.deleteRoom = [unavailable()];
    expectError(
      await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice }),
      503,
      'LIVEKIT_UNAVAILABLE',
    );
    expect(await testDb().db.select().from(channels).where(eq(channels.id, lounge.id))).toHaveLength(1);
    expect(await members()).toEqual({ [lounge.id]: [users.bob.id] });
  });

  it('a 404 from deleteRoom (no such room) still deletes', async () => {
    backend.fail.deleteRoom = [notFound()];
    expect(
      (await api(app, 'DELETE', `/api/channels/${games.id}`, { cookie: cookies.alice })).statusCode,
    ).toBe(204);
    expect(await testDb().db.select().from(channels).where(eq(channels.id, games.id))).toEqual([]);
  });

  it('text channels never touch LiveKit', async () => {
    expect(
      (await api(app, 'DELETE', `/api/channels/${general.id}`, { cookie: cookies.alice })).statusCode,
    ).toBe(204);
    expect(backend.calls).toEqual([]);
  });
});

describe('test reset', () => {
  const reset = () => api(app, 'POST', '/api/__test__/reset', { headers: { 'x-test-token': TOKEN } });

  it("deletes only this DB's rooms (404 fine) and clears voice memory and the webhook id cache", async () => {
    backend.put(lounge.id, users.bob.id, 'PA_b1');
    const foreign = randomUUID();
    backend.put(foreign, users.bob.id, 'PA_x');
    await join(lounge, 'bob', 'PA_b1');
    const replayed = webhookBody({
      event: 'participant_joined',
      channelId: lounge.id,
      userId: users.bob.id,
      sid: 'PA_b9',
      id: 'EV_same',
    });
    expect((await postWebhook(app, replayed)).statusCode).toBe(200);

    expect((await reset()).statusCode).toBe(200);
    expect(
      backend
        .callsOf('deleteRoom')
        .map((c) => c.room)
        .sort(),
    ).toEqual([voiceRoomName(lounge.id), voiceRoomName(games.id)].sort());
    expect(backend.rooms.has(voiceRoomName(foreign))).toBe(true);
    expect(app.voice.state.snapshot()).toEqual({});

    // Same event id, after the reset, for a channel that exists in the new DB: processed (cache cleared).
    const [again] = await testDb()
      .db.insert(channels)
      .values({ id: lounge.id, type: 'voice', name: 'lounge' })
      .returning();
    expect(again?.id).toBe(lounge.id);
    const bob = await insertUser('bob');
    const body = replayed.replace(users.bob.id, bob.id);
    expect((await postWebhook(app, body)).statusCode).toBe(200);
    expect(Object.keys(app.voice.state.snapshot())).toEqual([lounge.id]);
  });

  it('a LiveKit failure during the reset is logged and the reset still succeeds', async () => {
    backend.fail.deleteRoom = [unavailable(), unavailable()];
    expect((await reset()).statusCode).toBe(200);
    expect(await testDb().db.select().from(channels)).toEqual([]);
  });
});
