import {
  BootstrapResponse,
  InviteCheckResponse,
  InviteResponse,
  PublicUserResponse,
  ResetCodeResponse,
  RateLimitedDetails,
  UsersResponse,
  voiceRoomName,
  type PublicUser,
} from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, invites, users as usersTable } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { ADMIN_MUTATION_RATE_LIMIT } from '../src/plugins/rate-limit.js';
import { USERS_LOCK_KEY } from '../src/services/users.js';
import { makeApp, testEnv } from './helpers/app.js';
import {
  api,
  expectError,
  insertInvite,
  insertUser,
  login,
  PASSWORD,
  registerViaApi,
  sessionCount,
} from './helpers/auth.js';
import { connectRecording, insertChannel, insertDm, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { FakeVoiceBackend, notFound, postWebhook, unavailable } from './helpers/voice.js';
import { waitUntil } from './helpers/wait.js';

type Name = 'alice' | 'bob' | 'carol' | 'dave';
const NAMES: readonly Name[] = ['alice', 'bob', 'carol', 'dave'];

/** Long enough that a `presence {online:false}` seen within a test can only be the forced one. */
const LONG_GRACE_MS = 60_000;

let app: FastifyInstance;
let backend: FakeVoiceBackend;
let baseUrl: string;
let users: Record<Name, UserRow>;
const cookies: Record<Name, string> = { alice: '', bob: '', carol: '', dave: '' };
const opened: RecordingClient[] = [];
let lounge: ChannelRow;
let games: ChannelRow;
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  backend = new FakeVoiceBackend();
  app = makeApp({ voiceBackend: backend, timings: { presenceOfflineGraceMs: LONG_GRACE_MS } });
  baseUrl = await listen(app);
  await app.voice.reconciler.runNow();
  backend.calls.length = 0;
  users = {
    alice: await insertUser('alice', { role: 'admin' }),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
    dave: await insertUser('dave'),
  };
  for (const name of NAMES) cookies[name] = await login(app, name);
  lounge = await insertChannel('lounge', { type: 'voice', position: 0 });
  games = await insertChannel('games', { type: 'voice', position: 1 });
  general = await insertChannel('general', { position: 2 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of opened.splice(0)) s.client.disconnect();
  await app.close();
});
afterAll(closeTestDb);

/** A recording socket that also records its own `disconnect` as a pseudo-event, in arrival order. */
async function connect(name: Name, ignorePresence = true): Promise<RecordingClient> {
  const s = await connectRecording(baseUrl, cookies[name], ignorePresence ? { ignore: ['presence'] } : {});
  s.client.on('disconnect', () => {
    s.events.push({ event: '<disconnect>', payload: null });
  });
  opened.push(s);
  return s;
}

async function joinVoice(channel: ChannelRow, name: Name, sid = `PA_${name}`): Promise<void> {
  backend.put(channel.id, users[name].id, sid);
  const res = await postWebhook(app, {
    event: 'participant_joined',
    channelId: channel.id,
    userId: users[name].id,
    sid,
  });
  expect(res.statusCode, res.payload).toBe(200);
}

async function makeAdmin(name: Name): Promise<void> {
  await testDb().db.update(usersTable).set({ role: 'admin' }).where(eq(usersTable.id, users[name].id));
}

async function userRow(name: Name): Promise<UserRow> {
  const [row] = await testDb().db.select().from(usersTable).where(eq(usersTable.id, users[name].id));
  if (row === undefined) throw new Error('user missing');
  return row;
}

async function bootstrap(name: Name): Promise<BootstrapResponse> {
  const res = await api(app, 'GET', '/api/bootstrap', { cookie: cookies[name] });
  expect(res.statusCode, res.payload).toBe(200);
  return BootstrapResponse.parse(res.json());
}

const setRole = (actor: Name, target: Name, role: 'admin' | 'member', target_ = users[target].id) =>
  api(app, 'PATCH', `/api/admin/users/${target_}`, { cookie: cookies[actor], body: { role } });
const deactivate = (actor: Name, target: Name) =>
  api(app, 'POST', `/api/admin/users/${users[target].id}/deactivate`, { cookie: cookies[actor] });
const reactivate = (actor: Name, target: Name, on: FastifyInstance = app) =>
  api(on, 'POST', `/api/admin/users/${users[target].id}/reactivate`, { cookie: cookies[actor] });
const disconnectUrl = (channelId: string, userId: string): string =>
  `/api/voice/${channelId}/participants/${userId}/disconnect`;
const kickFromVoice = (actor: Name, channel: ChannelRow, target: Name) =>
  api(app, 'POST', disconnectUrl(channel.id, users[target].id), { cookie: cookies[actor] });

/** Position of the first recorded event named `event` (fails if absent). */
function indexOf(s: RecordingClient, event: string): number {
  const index = s.events.findIndex((e) => e.event === event);
  expect(index, `${event} in ${JSON.stringify(s.events.map((e) => e.event))}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** Positive control: after this, every event emitted before it has reached `s`. */
async function control(s: RecordingClient): Promise<void> {
  const before = s.of('channel:created').length;
  const res = await api(app, 'POST', '/api/channels', {
    cookie: cookies.alice,
    body: { type: 'text', name: `control-${before}` },
  });
  expect(res.statusCode, res.payload).toBe(201);
  await s.waitFor('channel:created', before + 1);
}

const firstCall = (spy: { mock: { invocationCallOrder: number[] } }): number => {
  const order = spy.mock.invocationCallOrder[0];
  if (order === undefined) throw new Error('spy was not called');
  return order;
};

/**
 * Holds the users advisory lock while `requests` start, until `waiting` of them are blocked on it (so all
 * of them passed their auth checks against the same state), runs `whileHeld` in the lock-holding
 * transaction, then releases it and returns their responses.
 */
async function raceUnderUsersLock<T>(
  waiting: number,
  requests: () => Promise<T>[],
  whileHeld?: (sql: (text: string, values: unknown[]) => Promise<unknown>) => Promise<void>,
): Promise<T[]> {
  const client = await testDb().pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [USERS_LOCK_KEY]);
    const pending = Promise.all(requests());
    await waitUntil(
      async () => {
        const { rows } = await client.query<{ n: string }>(
          "select count(*) as n from pg_locks where locktype = 'advisory' and not granted and objid = $1",
          [USERS_LOCK_KEY],
        );
        return Number(rows[0]?.n) >= waiting;
      },
      { message: `${waiting} transactions waiting on the users lock` },
    );
    await whileHeld?.((text, values) => client.query(text, values));
    await client.query('commit');
    return await pending;
  } finally {
    client.release();
  }
}

describe('admin user routes: access control', () => {
  const routes = (): ['PATCH' | 'POST', string, unknown][] => [
    ['PATCH', `/api/admin/users/${users.bob.id}`, { role: 'admin' }],
    ['POST', `/api/admin/users/${users.bob.id}/deactivate`, undefined],
    ['POST', `/api/admin/users/${users.bob.id}/reactivate`, undefined],
    ['POST', disconnectUrl(lounge.id, users.bob.id), undefined],
  ];

  it('non-admin → 403 FORBIDDEN, anonymous → 401; nothing changes', async () => {
    await joinVoice(lounge, 'bob');
    for (const [method, url, body] of routes()) {
      expectError(await api(app, method, url, { cookie: cookies.carol, body }), 403, 'FORBIDDEN');
      expectError(await api(app, method, url, { body }), 401, 'UNAUTHENTICATED');
    }
    expect(await userRow('bob')).toMatchObject({ role: 'member', deactivatedAt: null });
    expect(backend.callsOf('removeParticipant')).toEqual([]);
  });

  it('unknown user → 404 NOT_FOUND; malformed id or role → 400 VALIDATION', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expectError(await setRole('alice', 'bob', 'admin', unknown), 404, 'NOT_FOUND');
    for (const action of ['deactivate', 'reactivate']) {
      expectError(
        await api(app, 'POST', `/api/admin/users/${unknown}/${action}`, { cookie: cookies.alice }),
        404,
        'NOT_FOUND',
      );
    }
    expectError(await setRole('alice', 'bob', 'admin', 'nope'), 400, 'VALIDATION');
    const badRole = await api(app, 'PATCH', `/api/admin/users/${users.bob.id}`, {
      cookie: cookies.alice,
      body: { role: 'owner' },
    });
    expectError(badRole, 400, 'VALIDATION');
  });
});

describe('PATCH /api/admin/users/:id (row 35)', () => {
  it('promotes and demotes → {user} + user:updated to all; the same role again is a no-op', async () => {
    const carol = await connect('carol');
    const res = await setRole('alice', 'bob', 'admin');
    expect(res.statusCode, res.payload).toBe(200);
    expect(PublicUserResponse.parse(res.json()).user).toMatchObject({ id: users.bob.id, role: 'admin' });
    await carol.waitFor('user:updated');
    expect(carol.of('user:updated')).toEqual([
      { user: expect.objectContaining({ role: 'admin' }) as unknown },
    ]);
    // Bob's rights change with the role (read per request).
    expect((await api(app, 'GET', '/api/admin/invites', { cookie: cookies.bob })).statusCode).toBe(200);

    const again = await setRole('alice', 'bob', 'admin');
    expect(again.statusCode).toBe(200);
    expect(PublicUserResponse.parse(again.json()).user.role).toBe('admin');

    expect((await setRole('bob', 'bob', 'member')).statusCode).toBe(200);
    await control(carol);
    expect(carol.of('user:updated').map((p) => (p as { user: PublicUser }).user.role)).toEqual([
      'admin',
      'member',
    ]);
    expect((await userRow('bob')).role).toBe('member');
  });

  it('the only admin demoting themselves → 409 LAST_ADMIN, no change and no event', async () => {
    const carol = await connect('carol');
    expectError(await setRole('alice', 'alice', 'member'), 409, 'LAST_ADMIN');
    expect((await userRow('alice')).role).toBe('admin');
    await control(carol);
    expect(carol.of('user:updated')).toEqual([]);
  });

  it('a deactivated admin does not count: the only active admin still cannot step down', async () => {
    await makeAdmin('dave');
    await testDb()
      .db.update(usersTable)
      .set({ deactivatedAt: new Date() })
      .where(eq(usersTable.id, users.dave.id));
    expectError(await setRole('alice', 'alice', 'member'), 409, 'LAST_ADMIN');
    // Demoting the deactivated admin is fine: it leaves the active admin count unchanged.
    expect((await setRole('alice', 'dave', 'member')).statusCode).toBe(200);
  });

  it('with two admins, one may step down', async () => {
    await makeAdmin('dave');
    expect((await setRole('alice', 'alice', 'member')).statusCode).toBe(200);
    expect((await userRow('dave')).role).toBe('admin');
  });

  it('two admins demoting each other at the same time → exactly one succeeds, the other gets LAST_ADMIN', async () => {
    await makeAdmin('dave');
    // Both requests pass `requireAdmin` before either commits: only the in-transaction guard can stop one.
    const results = await raceUnderUsersLock(2, () => [
      setRole('alice', 'dave', 'member'),
      setRole('dave', 'alice', 'member'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    if (loser !== undefined) expectError(loser, 409, 'LAST_ADMIN');
    const roles = [(await userRow('alice')).role, (await userRow('dave')).role].sort();
    expect(roles).toEqual(['admin', 'member']);
  });

  it('unsynchronized mutual demotions: always exactly one admin left', async () => {
    for (let round = 0; round < 5; round += 1) {
      await makeAdmin('alice');
      await makeAdmin('dave');
      const results = await Promise.all([
        setRole('alice', 'dave', 'member'),
        setRole('dave', 'alice', 'member'),
      ]);
      // The loser is refused in the transaction (409) or, if it arrived after the commit, by requireAdmin.
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.map((r) => r.statusCode).every((code) => [200, 403, 409].includes(code))).toBe(true);
      const roles = [(await userRow('alice')).role, (await userRow('dave')).role].sort();
      expect(roles).toEqual(['admin', 'member']);
    }
  });
});

describe('POST /api/admin/users/:id/deactivate (row 36, B.7 teardown)', () => {
  it('runs the B.7 steps in order: DB → session:revoked + disconnect → removeParticipant → user:updated + presence', async () => {
    const bob = await connect('bob');
    const carol = await connect('carol', false);
    await joinVoice(lounge, 'bob', 'PA_b1');
    await carol.waitFor('voice:joined');

    const kicked = vi.spyOn(app.realtime, 'emitToUsers');
    const revoked = vi.spyOn(app.realtime, 'revokeUser');
    const removed = vi.spyOn(backend, 'removeParticipant');
    const broadcast = vi.spyOn(app.realtime, 'emitToAll');
    const forced = vi.spyOn(app.realtime, 'forceOffline');
    let dbDuringRemove: { sessions: number; deactivated: boolean } | null = null;
    backend.onCall = async (call) => {
      if (call.op !== 'removeParticipant') return;
      dbDuringRemove = {
        sessions: await sessionCount(users.bob.id),
        deactivated: (await userRow('bob')).deactivatedAt !== null,
      };
    };

    const res = await deactivate('alice', 'bob');
    expect(res.statusCode, res.payload).toBe(204);

    // Step 1 committed before LiveKit was called.
    expect(dbDuringRemove).toEqual({ sessions: 0, deactivated: true });
    expect(await sessionCount(users.bob.id)).toBe(0);

    // Step 2: bob hears why (voice:kicked, then session:revoked) before his socket is closed.
    await waitUntil(() => bob.events.some((e) => e.event === '<disconnect>'), { message: 'bob disconnect' });
    expect(bob.of('voice:kicked')).toEqual([{ channelId: lounge.id, reason: 'deactivated' }]);
    expect(bob.of('session:revoked')).toEqual([{ reason: 'deactivated' }]);
    expect(indexOf(bob, 'voice:kicked')).toBeLessThan(indexOf(bob, 'session:revoked'));
    expect(indexOf(bob, 'session:revoked')).toBeLessThan(indexOf(bob, '<disconnect>'));

    // Step 3: removeParticipant from the room he was in.
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(lounge.id), identity: users.bob.id },
    ]);

    // Step 4: user:updated, then an immediate offline (the grace period is 60 s here).
    // Carol connected after bob: she saw only her own online, then bob's forced offline.
    await carol.waitFor('presence', 2);
    expect(carol.of('presence')).toEqual([
      { userId: users.carol.id, online: true },
      { userId: users.bob.id, online: false },
    ]);
    expect(carol.of('user:updated')).toEqual([
      { user: expect.objectContaining({ id: users.bob.id, deactivated: true }) as unknown },
    ]);
    expect(carol.of('voice:left')).toEqual([{ channelId: lounge.id, userId: users.bob.id }]);
    expect(indexOf(carol, 'user:updated')).toBeLessThan(
      carol.events.findIndex((e) => e.event === 'presence' && JSON.stringify(e.payload).includes('false')),
    );

    // Server-side order across the systems.
    const userUpdated = broadcast.mock.calls.findIndex(([event]) => event === 'user:updated');
    const order = [
      firstCall(kicked),
      firstCall(revoked),
      firstCall(removed),
      broadcast.mock.invocationCallOrder[userUpdated] ?? -1,
      firstCall(forced),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const boot = await bootstrap('carol');
    expect(boot.onlineUserIds).not.toContain(users.bob.id);
    expect(boot.voice).toEqual({});
  });

  it('a second call is a no-op: 204, no events, no LiveKit call', async () => {
    await joinVoice(lounge, 'bob');
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);
    const carol = await connect('carol', false);
    backend.calls.length = 0;
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);
    await control(carol);
    expect(carol.events.filter((e) => e.event !== 'channel:created' && e.event !== 'presence')).toEqual([]);
    // Only carol's own online arrived.
    expect(carol.of('presence')).toEqual([{ userId: users.carol.id, online: true }]);
    expect(backend.calls).toEqual([]);
  });

  it('a deactivated user cannot log in, is `deactivated` in /users and bootstrap, and their DM is read-only', async () => {
    const dm = await insertDm(users.alice.id, users.bob.id);
    const oldCookie = cookies.bob;
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);

    const loginRes = await api(app, 'POST', '/api/auth/login', {
      body: { username: 'bob', password: PASSWORD },
    });
    expectError(loginRes, 401, 'INVALID_CREDENTIALS');
    expectError(await api(app, 'GET', '/api/me', { cookie: oldCookie }), 401, 'UNAUTHENTICATED');
    expectError(
      await api(app, 'POST', `/api/voice/${lounge.id}/token`, { cookie: oldCookie }),
      401,
      'UNAUTHENTICATED',
    );

    const listed = UsersResponse.parse(
      (await api(app, 'GET', '/api/users', { cookie: cookies.carol })).json(),
    );
    expect(listed.users.find((u) => u.id === users.bob.id)).toMatchObject({ deactivated: true });
    expect((await bootstrap('carol')).users.find((u) => u.id === users.bob.id)).toMatchObject({
      deactivated: true,
    });

    const send = await api(app, 'POST', `/api/channels/${dm}/messages`, {
      cookie: cookies.alice,
      body: { content: 'hello?' },
    });
    expectError(send, 403, 'FORBIDDEN');
  });

  it('a user who is not in voice gets no voice:kicked and LiveKit is not called', async () => {
    const bob = await connect('bob');
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);
    await waitUntil(() => bob.events.some((e) => e.event === '<disconnect>'));
    expect(bob.events.map((e) => e.event)).toEqual(['session:revoked', '<disconnect>']);
    expect(backend.calls).toEqual([]);
  });

  it('the only admin deactivating themselves → 409 LAST_ADMIN; nothing changes', async () => {
    expectError(await deactivate('alice', 'alice'), 409, 'LAST_ADMIN');
    expect((await userRow('alice')).deactivatedAt).toBeNull();
    expect(await sessionCount(users.alice.id)).toBe(1);
  });

  it('two admins deactivating each other concurrently → exactly one succeeds', async () => {
    await makeAdmin('dave');
    const results = await raceUnderUsersLock(2, () => [
      deactivate('alice', 'dave'),
      deactivate('dave', 'alice'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    if (loser !== undefined) expectError(loser, 409, 'LAST_ADMIN');
    const active = [await userRow('alice'), await userRow('dave')].filter((u) => u.deactivatedAt === null);
    expect(active).toHaveLength(1);
  });

  it('a LiveKit failure after the commit is logged and still 204; the reconcile then removes the participant', async () => {
    const carol = await connect('carol');
    await joinVoice(lounge, 'bob', 'PA_b1');
    backend.fail.removeParticipant = [unavailable()];
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);
    expect((await userRow('bob')).deactivatedAt).not.toBeNull();
    await carol.waitFor('user:updated');
    // LiveKit still has bob; the reconcile removes him and never tracks him again.
    expect(backend.rooms.get(voiceRoomName(lounge.id))?.map((p) => p.identity)).toEqual([users.bob.id]);
    await app.voice.reconciler.runNow();
    expect(backend.callsOf('removeParticipant')).toHaveLength(2);
    expect(backend.rooms.get(voiceRoomName(lounge.id))).toEqual([]);
    expect(app.voice.state.snapshot()).toEqual({});
  });

  it('a deactivated user joining with a still-valid token is removed, not tracked', async () => {
    await testDb()
      .db.update(usersTable)
      .set({ deactivatedAt: new Date() })
      .where(eq(usersTable.id, users.bob.id));
    await joinVoice(lounge, 'bob', 'PA_late');
    await waitUntil(() => backend.callsOf('removeParticipant').length === 1);
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(lounge.id), identity: users.bob.id },
    ]);
    expect(app.voice.state.snapshot()).toEqual({});
  });

  it('a join webhook that checked the user before the commit is still removed (B.9 rule 8)', async () => {
    const voice = app.voice.state;
    const bob = users.bob.id;
    backend.put(lounge.id, bob, 'PA_race');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The join webhook's task: its deactivation check passed before the commit; it adds bob when it resumes.
    const joined = voice.exclusive(async () => {
      await gate;
      voice.participantJoined(lounge.id, { userId: bob, sid: 'PA_race', joinedAt: new Date() });
    });
    const res = deactivate('alice', 'bob');
    await waitUntil(async () => (await userRow('bob')).deactivatedAt !== null, {
      message: 'deactivation committed',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await joined;
    expect((await res).statusCode).toBe(204);
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(lounge.id), identity: bob },
    ]);
    expect(voice.snapshot()).toEqual({});
  });
});

describe('deactivation voids credentials (B.7b rule 7)', () => {
  const issueCode = async (actor: Name, target: Name): Promise<string> => {
    const res = await api(app, 'POST', `/api/admin/users/${users[target].id}/reset-code`, {
      cookie: cookies[actor],
    });
    expect(res.statusCode, res.payload).toBe(200);
    return ResetCodeResponse.parse(res.json()).code;
  };
  const createInviteAs = async (actor: Name, maxUses = 1): Promise<string> => {
    const res = await api(app, 'POST', '/api/admin/invites', { cookie: cookies[actor], body: { maxUses } });
    expect(res.statusCode, res.payload).toBe(201);
    return InviteResponse.parse(res.json()).invite.code;
  };
  const inviteValid = async (code: string): Promise<boolean> => {
    const res = await api(app, 'GET', `/api/invites/${code}/check`);
    expect(res.statusCode, res.payload).toBe(200);
    return InviteCheckResponse.parse(res.json()).valid;
  };

  it('a reset code issued before the deactivation fails after the reactivation', async () => {
    const code = await issueCode('alice', 'bob');
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);
    expect((await reactivate('alice', 'bob')).statusCode).toBe(204);
    expectError(
      await api(app, 'POST', '/api/auth/reset-password', {
        body: { username: 'bob', code, newPassword: 'a sneaky new password' },
      }),
      401,
      'INVALID_CREDENTIALS',
    );
    // The old password still works, and a code issued now does.
    await login(app, 'bob');
    const fresh = await issueCode('alice', 'bob');
    const reset = await api(app, 'POST', '/api/auth/reset-password', {
      body: { username: 'bob', code: fresh, newPassword: 'a fresh new password' },
    });
    expect(reset.statusCode, reset.payload).toBe(204);
  });

  it("a deactivated admin's unused invites are revoked (also after reactivation); others' are kept", async () => {
    await makeAdmin('dave');
    const single = await createInviteAs('dave');
    const multi = await createInviteAs('dave', 3);
    // Partly used: still redeemable, so revoked too.
    expect((await registerViaApi(app, 'erin', multi)).statusCode).toBe(201);
    const aliceInvite = await createInviteAs('alice');
    expect(await inviteValid(single)).toBe(true);

    expect((await deactivate('alice', 'dave')).statusCode).toBe(204);
    expect(await inviteValid(single)).toBe(false);
    expect(await inviteValid(multi)).toBe(false);
    expectError(await registerViaApi(app, 'frank', single), 400, 'INVITE_INVALID');
    expect(await inviteValid(aliceInvite)).toBe(true);

    expect((await reactivate('alice', 'dave')).statusCode).toBe(204);
    expect(await inviteValid(single)).toBe(false);
    const rows = await testDb().db.select().from(invites).where(eq(invites.createdBy, users.dave.id));
    expect(rows.map((row) => row.revokedAt !== null)).toEqual([true, true]);
  });

  it('used-up and expired invites keep their status', async () => {
    await makeAdmin('dave');
    const used = await createInviteAs('dave');
    expect((await registerViaApi(app, 'erin', used)).statusCode).toBe(201);
    const expiring = await createInviteAs('dave');
    await testDb()
      .db.update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.code, expiring));
    expect((await deactivate('alice', 'dave')).statusCode).toBe(204);
    const rows = await testDb().db.select().from(invites).where(eq(invites.createdBy, users.dave.id));
    expect(rows.map((row) => row.revokedAt)).toEqual([null, null]);
  });
});

describe('admin mutations re-check the actor inside the transaction (B.7b rule 7)', () => {
  const demoteAlice = (sql: (text: string, values: unknown[]) => Promise<unknown>) =>
    sql("update users set role = 'member' where id = $1", [users.alice.id]).then(() => undefined);

  it('row 38: an admin demoted while the reset-code request waits → 403, no code issued', async () => {
    await makeAdmin('dave');
    const [res] = await raceUnderUsersLock(
      1,
      () => [api(app, 'POST', `/api/admin/users/${users.bob.id}/reset-code`, { cookie: cookies.alice })],
      demoteAlice,
    );
    if (res === undefined) throw new Error('no response');
    expectError(res, 403, 'FORBIDDEN');
    const codes = await testDb().pool.query('select 1 from password_reset_codes');
    expect(codes.rowCount).toBe(0);
  });

  it('rows 15–18 and 33–34: demoted mid-request → 403 and nothing changes', async () => {
    const invite = await insertInvite();
    const requests: [string, () => Promise<{ statusCode: number; payload: string }>][] = [
      [
        'create channel',
        () => api(app, 'POST', '/api/channels', { cookie: cookies.alice, body: { type: 'text', name: 'x' } }),
      ],
      [
        'rename channel',
        () =>
          api(app, 'PATCH', `/api/channels/${general.id}`, {
            cookie: cookies.alice,
            body: { name: 'renamed' },
          }),
      ],
      [
        'reorder channels',
        () =>
          api(app, 'PUT', '/api/channels/order', {
            cookie: cookies.alice,
            body: { ids: [general.id, games.id, lounge.id] },
          }),
      ],
      ['delete channel', () => api(app, 'DELETE', `/api/channels/${general.id}`, { cookie: cookies.alice })],
      ['create invite', () => api(app, 'POST', '/api/admin/invites', { cookie: cookies.alice })],
      [
        'revoke invite',
        () => api(app, 'DELETE', `/api/admin/invites/${invite.id}`, { cookie: cookies.alice }),
      ],
    ];
    for (const [label, request] of requests) {
      const [res] = await raceUnderUsersLock(1, () => [request()], demoteAlice);
      expect(res?.statusCode, `${label}: ${res?.payload}`).toBe(403);
      await makeAdmin('alice');
    }
    const rows = await testDb().db.select().from(channels);
    expect(rows.map((row) => [row.name, row.position]).sort()).toEqual(
      [
        ['games', 1],
        ['general', 2],
        ['lounge', 0],
      ].sort(),
    );
    expect((await testDb().db.select().from(invites)).map((row) => row.revokedAt)).toEqual([null]);
    // Positive control: re-promoted (no lock held), the same kind of request goes through.
    expect((await api(app, 'POST', '/api/admin/invites', { cookie: cookies.alice })).statusCode).toBe(201);
  });

  it('row 31: an admin demoted while the voice disconnect waits → 403, nobody kicked', async () => {
    const bob = await connect('bob');
    await joinVoice(lounge, 'bob');
    const [res] = await raceUnderUsersLock(1, () => [kickFromVoice('alice', lounge, 'bob')], demoteAlice);
    if (res === undefined) throw new Error('no response');
    expectError(res, 403, 'FORBIDDEN');
    expect(backend.callsOf('removeParticipant')).toEqual([]);
    expect(Object.keys(app.voice.state.snapshot())).toEqual([lounge.id]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.of('voice:kicked')).toEqual([]);
  });
});

describe('POST /api/admin/users/:id/reactivate (row 37)', () => {
  it('USER_LIMIT at the cap; below it 204 + user:updated, login works again, old sessions stay gone', async () => {
    const own = makeApp({ env: testEnv({ MAX_USERS: '4' }), voiceBackend: backend });
    await own.ready();
    try {
      const oldCookie = cookies.bob;
      expect(
        (await api(own, 'POST', `/api/admin/users/${users.bob.id}/deactivate`, { cookie: cookies.alice }))
          .statusCode,
      ).toBe(204);
      const erin = await insertUser('erin'); // back at 4 active users
      expectError(await reactivate('alice', 'bob', own), 403, 'USER_LIMIT');
      expect((await userRow('bob')).deactivatedAt).not.toBeNull();

      await testDb()
        .db.update(usersTable)
        .set({ deactivatedAt: new Date() })
        .where(eq(usersTable.id, erin.id));
      expect((await reactivate('alice', 'bob', own)).statusCode).toBe(204);
      expect((await userRow('bob')).deactivatedAt).toBeNull();
      expectError(await api(own, 'GET', '/api/me', { cookie: oldCookie }), 401, 'UNAUTHENTICATED');
      expect((await login(own, 'bob')).length).toBeGreaterThan(0);
    } finally {
      await own.close();
    }
  });

  it('broadcasts user:updated {deactivated:false}; reactivating an active user is a no-op', async () => {
    expect((await deactivate('alice', 'bob')).statusCode).toBe(204);
    const carol = await connect('carol');
    expect((await reactivate('alice', 'bob')).statusCode).toBe(204);
    await carol.waitFor('user:updated');
    expect(carol.of('user:updated')).toEqual([
      { user: expect.objectContaining({ id: users.bob.id, deactivated: false }) as unknown },
    ]);
    expect((await reactivate('alice', 'bob')).statusCode).toBe(204);
    expect((await reactivate('alice', 'carol')).statusCode).toBe(204);
    await control(carol);
    expect(carol.of('user:updated')).toHaveLength(1);
  });

  it('two reactivations racing for the last free slot → exactly one succeeds', async () => {
    const own = makeApp({ env: testEnv({ MAX_USERS: '3' }), voiceBackend: backend });
    await own.ready();
    try {
      await testDb()
        .db.update(usersTable)
        .set({ deactivatedAt: new Date() })
        .where(eq(usersTable.id, users.bob.id));
      await testDb()
        .db.update(usersTable)
        .set({ deactivatedAt: new Date() })
        .where(eq(usersTable.id, users.carol.id));
      // Active: alice, dave → one slot left.
      const results = await raceUnderUsersLock(2, () => [
        reactivate('alice', 'bob', own),
        reactivate('alice', 'carol', own),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 403]);
      const loser = results.find((r) => r.statusCode === 403);
      if (loser !== undefined) expectError(loser, 403, 'USER_LIMIT');
      const active = [await userRow('bob'), await userRow('carol')].filter((u) => u.deactivatedAt === null);
      expect(active).toHaveLength(1);
    } finally {
      await own.close();
    }
  });
});

describe('POST /api/voice/:channelId/participants/:userId/disconnect (row 31)', () => {
  it('sends voice:kicked {admin} to the user, then removeParticipant; voice:left to all', async () => {
    const bob = await connect('bob');
    const carol = await connect('carol');
    await joinVoice(lounge, 'bob', 'PA_b1');
    const kicked = vi.spyOn(app.realtime, 'emitToUsers');
    const removed = vi.spyOn(backend, 'removeParticipant');

    const res = await kickFromVoice('alice', lounge, 'bob');
    expect(res.statusCode, res.payload).toBe(204);
    expect(firstCall(kicked)).toBeLessThan(firstCall(removed));
    expect(backend.callsOf('removeParticipant')).toEqual([
      { op: 'removeParticipant', room: voiceRoomName(lounge.id), identity: users.bob.id },
    ]);
    await bob.waitFor('voice:kicked');
    expect(bob.of('voice:kicked')).toEqual([{ channelId: lounge.id, reason: 'admin' }]);
    await carol.waitFor('voice:left');
    expect(carol.of('voice:kicked')).toEqual([]);
    expect(app.voice.state.snapshot()).toEqual({});
    // LiveKit's own participant_left for that connection is now stale and harmless.
    const left = await postWebhook(app, {
      event: 'participant_left',
      channelId: lounge.id,
      userId: users.bob.id,
      sid: 'PA_b1',
    });
    expect(left.statusCode).toBe(200);
    await control(carol);
    expect(carol.of('voice:left')).toHaveLength(1);
  });

  it('a user who is not in that channel, or an unknown / text channel → 404 NOT_FOUND', async () => {
    await joinVoice(games, 'bob');
    expectError(await kickFromVoice('alice', lounge, 'bob'), 404, 'NOT_FOUND');
    expectError(await kickFromVoice('alice', lounge, 'carol'), 404, 'NOT_FOUND');
    expectError(await kickFromVoice('alice', general, 'bob'), 404, 'NOT_FOUND');
    expectError(
      await api(app, 'POST', disconnectUrl('00000000-0000-4000-8000-000000000000', users.bob.id), {
        cookie: cookies.alice,
      }),
      404,
      'NOT_FOUND',
    );
    expect(backend.callsOf('removeParticipant')).toEqual([]);
  });

  it('a non-admin → 403', async () => {
    await joinVoice(lounge, 'bob');
    expectError(await kickFromVoice('carol', lounge, 'bob'), 403, 'FORBIDDEN');
    expect(backend.callsOf('removeParticipant')).toEqual([]);
  });

  it('LiveKit down → 503 LIVEKIT_UNAVAILABLE and the membership is kept', async () => {
    const bob = await connect('bob');
    await joinVoice(lounge, 'bob');
    // A failing removeParticipant.
    backend.fail.removeParticipant = [unavailable()];
    expectError(await kickFromVoice('alice', lounge, 'bob'), 503, 'LIVEKIT_UNAVAILABLE');
    expect(Object.keys(app.voice.state.snapshot())).toEqual([lounge.id]);

    // The cached health says down: refused before anything is sent.
    backend.fail.listRooms = [unavailable()];
    await app.voice.reconciler.runNow();
    backend.calls.length = 0;
    await bob.waitFor('voice:kicked');
    const before = bob.of('voice:kicked').length;
    expectError(await kickFromVoice('alice', lounge, 'bob'), 503, 'LIVEKIT_UNAVAILABLE');
    expect(backend.calls).toEqual([]);
    await control(bob);
    expect(bob.of('voice:kicked')).toHaveLength(before);
  });

  it('a 404 from LiveKit (already gone) counts as success', async () => {
    await joinVoice(lounge, 'bob');
    backend.fail.removeParticipant = [notFound()];
    expect((await kickFromVoice('alice', lounge, 'bob')).statusCode).toBe(204);
    expect(app.voice.state.snapshot()).toEqual({});
  });
});

describe('DELETE /api/channels/:id with voice occupants (row 18)', () => {
  it('deleteRoom, then the DB delete, then voice:kicked {channel_deleted} to each occupant only, then channel:deleted', async () => {
    const bob = await connect('bob');
    const carol = await connect('carol');
    const dave = await connect('dave');
    await joinVoice(lounge, 'bob');
    await joinVoice(lounge, 'carol');
    let existedDuringDeleteRoom: boolean | null = null;
    backend.onCall = async (call) => {
      // The first deleteRoom (the second one, after the commit, has its own test).
      if (call.op !== 'deleteRoom' || existedDuringDeleteRoom !== null) return;
      const rows = await testDb().db.select().from(channels).where(eq(channels.id, lounge.id));
      existedDuringDeleteRoom = rows.length === 1;
    };
    const deleteRoom = vi.spyOn(backend, 'deleteRoom');
    const kicked = vi.spyOn(app.realtime, 'emitToUsers');
    let goneWhenKicked: boolean | null = null;
    bob.client.on('voice:kicked', () => {
      void testDb()
        .db.select()
        .from(channels)
        .where(eq(channels.id, lounge.id))
        .then((rows) => {
          goneWhenKicked = rows.length === 0;
        });
    });

    const res = await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice });
    expect(res.statusCode, res.payload).toBe(204);
    expect(existedDuringDeleteRoom).toBe(true);
    expect(firstCall(deleteRoom)).toBeLessThan(firstCall(kicked));
    await waitUntil(() => goneWhenKicked !== null);
    expect(goneWhenKicked).toBe(true);

    for (const s of [bob, carol]) {
      await s.waitFor('channel:deleted');
      expect(s.of('voice:kicked')).toEqual([{ channelId: lounge.id, reason: 'channel_deleted' }]);
      expect(indexOf(s, 'voice:kicked')).toBeLessThan(indexOf(s, 'channel:deleted'));
    }
    await dave.waitFor('channel:deleted');
    expect(dave.of('voice:kicked')).toEqual([]);
    expect(app.voice.state.snapshot()).toEqual({});
  });

  it('occupants whose participant_left lands between deleteRoom and the DB delete are still notified', async () => {
    const bob = await connect('bob');
    await joinVoice(lounge, 'bob', 'PA_b1');
    backend.onCall = async (call) => {
      if (call.op !== 'deleteRoom') return;
      await postWebhook(app, {
        event: 'participant_left',
        channelId: lounge.id,
        userId: users.bob.id,
        sid: 'PA_b1',
      });
    };
    expect(
      (await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice })).statusCode,
    ).toBe(204);
    await bob.waitFor('channel:deleted');
    expect(bob.of('voice:kicked')).toEqual([{ channelId: lounge.id, reason: 'channel_deleted' }]);
  });

  it('deletes the room again after the commit: deleteRoom → DB delete → deleteRoom (a 404 is fine)', async () => {
    const bob = await connect('bob');
    await joinVoice(lounge, 'bob');
    const existed: boolean[] = [];
    backend.onCall = async (call) => {
      if (call.op !== 'deleteRoom') return;
      const rows = await testDb().db.select().from(channels).where(eq(channels.id, lounge.id));
      existed.push(rows.length === 1);
    };
    const res = await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice });
    expect(res.statusCode, res.payload).toBe(204);
    expect(backend.callsOf('deleteRoom')).toEqual([
      { op: 'deleteRoom', room: voiceRoomName(lounge.id) },
      { op: 'deleteRoom', room: voiceRoomName(lounge.id) },
    ]);
    // The first before the DB delete, the second (answered 404 by the fake) after its commit.
    expect(existed).toEqual([true, false]);
    await bob.waitFor('channel:deleted');
  });

  it('a room re-created by a join before the commit is closed by the second deleteRoom', async () => {
    const original = backend.deleteRoom.bind(backend);
    vi.spyOn(backend, 'deleteRoom').mockImplementationOnce(async (room) => {
      await original(room);
      // Someone joins with a still-valid token: LiveKit auto-creates the room again.
      backend.put(lounge.id, users.carol.id, 'PA_late');
    });
    const res = await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice });
    expect(res.statusCode, res.payload).toBe(204);
    expect(backend.rooms.has(voiceRoomName(lounge.id))).toBe(false);
  });

  it('a failing second deleteRoom is only logged: still 204 and channel:deleted', async () => {
    const bob = await connect('bob');
    let n = 0;
    backend.onCall = (call) => {
      if (call.op === 'deleteRoom' && ++n === 2) throw unavailable();
    };
    const res = await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice });
    expect(res.statusCode, res.payload).toBe(204);
    expect(n).toBe(2);
    await bob.waitFor('channel:deleted');
    expect(await testDb().db.select().from(channels).where(eq(channels.id, lounge.id))).toEqual([]);
  });

  it('LiveKit down → 503, the DB untouched, nobody kicked', async () => {
    const bob = await connect('bob');
    await joinVoice(lounge, 'bob');
    backend.fail.deleteRoom = [unavailable()];
    expectError(
      await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie: cookies.alice }),
      503,
      'LIVEKIT_UNAVAILABLE',
    );
    expect(await testDb().db.select().from(channels).where(eq(channels.id, lounge.id))).toHaveLength(1);
    await control(bob);
    expect(bob.of('voice:kicked')).toEqual([]);
    expect(bob.of('channel:deleted')).toEqual([]);
  });
});

describe('admin mutation rate limit', () => {
  it(`the ${ADMIN_MUTATION_RATE_LIMIT.max + 1}th admin mutation in a minute → 429 with retryAfterMs, across routes, per admin`, async () => {
    expect(ADMIN_MUTATION_RATE_LIMIT).toEqual({ max: 60, windowMs: 60_000 });
    await makeAdmin('dave');
    for (let i = 0; i < ADMIN_MUTATION_RATE_LIMIT.max; i += 1) {
      const res =
        i % 2 === 0
          ? await api(app, 'POST', '/api/admin/invites', { cookie: cookies.alice })
          : await setRole('alice', 'bob', i % 4 === 1 ? 'admin' : 'member');
      expect(res.statusCode, res.payload).toBeLessThan(300);
    }
    for (const res of [
      await setRole('alice', 'carol', 'admin'),
      await deactivate('alice', 'carol'),
      await api(app, 'POST', '/api/channels', { cookie: cookies.alice, body: { type: 'text', name: 'x' } }),
      await kickFromVoice('alice', lounge, 'bob'),
    ]) {
      const body = expectError(res, 429, 'RATE_LIMITED');
      const { retryAfterMs } = RateLimitedDetails.parse(body.error.details);
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(ADMIN_MUTATION_RATE_LIMIT.windowMs);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect((await userRow('carol')).role).toBe('member');
    // Reads are not limited; another admin has their own window.
    expect((await api(app, 'GET', '/api/admin/invites', { cookie: cookies.alice })).statusCode).toBe(200);
    expect((await setRole('dave', 'carol', 'admin')).statusCode).toBe(200);
  });
});
