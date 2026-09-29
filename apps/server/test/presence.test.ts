import { BootstrapResponse, LIMITS, PresencePayload } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRow } from '../src/db/types.js';
import { createPresence } from '../src/realtime/presence.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, insertUser, login } from './helpers/auth.js';
import { connectRecording, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

/** Shortened for the socket tests (test-only `timings` option); the unit tests below use the real 3 s. */
const GRACE_MS = 200;
const TOKEN = 'presence-test-token';

describe('createPresence (fake timers, real grace period)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('online on the first socket only; offline exactly after the grace period after the last one', () => {
    vi.useFakeTimers();
    const emitted: PresencePayload[] = [];
    const presence = createPresence({
      graceMs: LIMITS.presenceOfflineGraceMs,
      emit: (p) => emitted.push(p),
    });

    presence.connect('u1', 's1');
    presence.connect('u1', 's2');
    expect(emitted).toEqual([{ userId: 'u1', online: true }]);
    presence.disconnect('u1', 's1');
    presence.disconnect('u1', 'unknown-socket');
    vi.advanceTimersByTime(LIMITS.presenceOfflineGraceMs * 2);
    expect(emitted).toHaveLength(1);

    presence.disconnect('u1', 's2');
    vi.advanceTimersByTime(LIMITS.presenceOfflineGraceMs - 1);
    expect(emitted).toHaveLength(1);
    // Still listed as online during the grace period.
    expect(presence.onlineUserIds()).toEqual(['u1']);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual([
      { userId: 'u1', online: true },
      { userId: 'u1', online: false },
    ]);
    expect(presence.onlineUserIds()).toEqual([]);
  });

  it('a reconnect within the grace period cancels the offline and emits nothing', () => {
    vi.useFakeTimers();
    const emitted: PresencePayload[] = [];
    const presence = createPresence({ graceMs: 3_000, emit: (p) => emitted.push(p) });
    presence.connect('u1', 's1');
    presence.disconnect('u1', 's1');
    vi.advanceTimersByTime(2_999);
    presence.connect('u1', 's2');
    vi.advanceTimersByTime(10_000);
    expect(emitted).toEqual([{ userId: 'u1', online: true }]);
    expect(presence.onlineUserIds()).toEqual(['u1']);
  });

  it('forceOffline() emits offline at once, cancels a pending offline, and ignores later disconnects', () => {
    vi.useFakeTimers();
    const emitted: PresencePayload[] = [];
    const presence = createPresence({ graceMs: 3_000, emit: (p) => emitted.push(p) });
    presence.connect('u1', 's1');
    presence.connect('u1', 's2');
    presence.connect('u2', 's3');
    presence.disconnect('u2', 's3'); // u2 is within its grace period
    presence.forceOffline('u1');
    presence.forceOffline('u2');
    expect(emitted.slice(2)).toEqual([
      { userId: 'u1', online: false },
      { userId: 'u2', online: false },
    ]);
    // The sockets' own disconnects (and the cancelled grace timer) add nothing.
    presence.disconnect('u1', 's1');
    presence.disconnect('u1', 's2');
    vi.advanceTimersByTime(10_000);
    expect(emitted).toHaveLength(4);
    expect(presence.onlineUserIds()).toEqual([]);
    // Someone already offline: nothing.
    presence.forceOffline('u3');
    expect(emitted).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clear() forgets everything and cancels pending offlines without emitting', () => {
    vi.useFakeTimers();
    const emitted: PresencePayload[] = [];
    const presence = createPresence({ graceMs: 3_000, emit: (p) => emitted.push(p) });
    presence.connect('u1', 's1');
    presence.connect('u2', 's2');
    presence.disconnect('u1', 's1');
    presence.clear();
    vi.advanceTimersByTime(10_000);
    expect(emitted).toEqual([
      { userId: 'u1', online: true },
      { userId: 'u2', online: true },
    ]);
    expect(presence.onlineUserIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('presence over sockets', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let alice: UserRow;
  let bob: UserRow;
  let carol: UserRow;
  const cookies: Record<string, string> = {};
  const opened: RecordingClient[] = [];

  beforeEach(async () => {
    await truncateAll();
    app = makeApp({
      env: testEnv({ HEARTH_TEST_MODE: 'true', HEARTH_TEST_TOKEN: TOKEN }),
      timings: { presenceOfflineGraceMs: GRACE_MS },
    });
    baseUrl = await listen(app);
    alice = await insertUser('alice');
    bob = await insertUser('bob');
    carol = await insertUser('carol');
    for (const name of ['alice', 'bob', 'carol']) cookies[name] = await login(app, name);
  });
  afterEach(async () => {
    for (const s of opened.splice(0)) s.client.disconnect();
    await app.close();
  });
  afterAll(closeTestDb);

  async function connect(name: string): Promise<RecordingClient> {
    const cookie = cookies[name];
    if (cookie === undefined) throw new Error(`no cookie for ${name}`);
    const s = await connectRecording(baseUrl, cookie);
    opened.push(s);
    return s;
  }

  /** Closes a client and waits until the server has processed the disconnect. */
  async function close(s: RecordingClient): Promise<void> {
    const before = app.realtime.io.sockets.sockets.size;
    s.client.disconnect();
    await waitUntil(() => app.realtime.io.sockets.sockets.size === before - 1, {
      message: 'server disconnect',
    });
  }

  function presenceOf(s: RecordingClient, userId: string): PresencePayload[] {
    return s
      .of('presence')
      .map((p) => PresencePayload.parse(p))
      .filter((p) => p.userId === userId);
  }

  /** Positive control: bob connects; once the observer has heard it, earlier events would have arrived too. */
  async function control(observer: RecordingClient): Promise<RecordingClient> {
    const bobSocket = await connect('bob');
    await waitUntil(() => presenceOf(observer, bob.id).length > 0, { message: 'bob online (control)' });
    return bobSocket;
  }

  async function onlineIds(name: string): Promise<string[]> {
    const res = await api(app, 'GET', '/api/bootstrap', { cookie: cookies[name] });
    expect(res.statusCode, res.payload).toBe(200);
    return BootstrapResponse.parse(res.json()).onlineUserIds;
  }

  it('first socket → online to everyone (itself included); a second socket → nothing', async () => {
    const observer = await connect('carol');
    const a1 = await connect('alice');
    await waitUntil(() => presenceOf(observer, alice.id).length === 1, { message: 'alice online' });
    await connect('alice');
    await control(observer);
    expect(presenceOf(observer, alice.id)).toEqual([{ userId: alice.id, online: true }]);
    expect(presenceOf(a1, alice.id)).toEqual([{ userId: alice.id, online: true }]);
  });

  it('closing one of two sockets → nothing; closing the last → offline only after the grace period', async () => {
    const observer = await connect('carol');
    const a1 = await connect('alice');
    const a2 = await connect('alice');
    await close(a1);
    await control(observer);
    expect(presenceOf(observer, alice.id)).toEqual([{ userId: alice.id, online: true }]);

    const closedAt = Date.now();
    await close(a2);
    // Within the grace period: nothing yet, and bootstrap still lists alice.
    expect(await onlineIds('carol')).toContain(alice.id);
    expect(presenceOf(observer, alice.id)).toHaveLength(1);
    await waitUntil(() => presenceOf(observer, alice.id).length === 2, { message: 'alice offline' });
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(GRACE_MS - 5);
    expect(presenceOf(observer, alice.id)).toEqual([
      { userId: alice.id, online: true },
      { userId: alice.id, online: false },
    ]);
    expect(await onlineIds('carol')).not.toContain(alice.id);
  });

  it('reconnecting within the grace period emits nothing at all', async () => {
    const observer = await connect('carol');
    const a1 = await connect('alice');
    await waitUntil(() => presenceOf(observer, alice.id).length === 1, { message: 'alice online' });
    await close(a1);
    await connect('alice');
    // Let the original grace period run out, then check with a control.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    await control(observer);
    expect(presenceOf(observer, alice.id)).toEqual([{ userId: alice.id, online: true }]);
  });

  it('bootstrap lists the online user ids', async () => {
    expect(await onlineIds('carol')).toEqual([]);
    await connect('alice');
    await connect('carol');
    expect(await onlineIds('bob')).toEqual([alice.id, carol.id].sort());
  });

  it('the test reset clears presence state (no stale online ids, no late offline)', async () => {
    const observer = await connect('carol');
    await connect('alice');
    await waitUntil(() => presenceOf(observer, alice.id).length === 1, { message: 'alice online' });
    expect(app.realtime.onlineUserIds()).toHaveLength(2);
    const res = await api(app, 'POST', '/api/__test__/reset', { headers: { 'x-test-token': TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(app.realtime.onlineUserIds()).toEqual([]);

    // A socket connected after the reset never hears a late offline for the dropped sockets.
    const dave = await insertUser('dave');
    cookies.dave = await login(app, 'dave');
    const after = await connect('dave');
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    expect(after.of('presence')).toEqual([{ userId: dave.id, online: true }]);
    expect(app.realtime.onlineUserIds()).toEqual([dave.id]);
  });
});
