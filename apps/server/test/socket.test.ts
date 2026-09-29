import {
  ConnectErrorData,
  ResetCodeResponse,
  SESSION_COOKIE,
  SOCKET_PATH,
  UsersResponse,
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SessionRevokedPayload,
  type UserUpdatedPayload,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { onClientEvent } from '../src/realtime/io.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, insertUser, login, PASSWORD } from './helpers/auth.js';
import { closeTestDb, truncateAll } from './helpers/db.js';
import { waitUntil } from './helpers/wait.js';

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const ORIGIN = 'http://localhost:5173';
const TOKEN = 'socket-test-token';

let app: FastifyInstance;
let baseUrl: string;
const clients: Client[] = [];

beforeEach(async () => {
  await truncateAll();
  app = makeApp({ env: testEnv({ HEARTH_TEST_MODE: 'true', HEARTH_TEST_TOKEN: TOKEN }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await app.close();
});
afterAll(closeTestDb);

function connect({ cookie, origin = ORIGIN }: { cookie?: string; origin?: string }): Client {
  const extraHeaders: Record<string, string> = { origin };
  if (cookie !== undefined) extraHeaders.cookie = cookie;
  const client: Client = connectClient(baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders,
  });
  clients.push(client);
  return client;
}

/** Resolves once connected, or rejects with the handshake error. */
function connected(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once('connect', () => {
      resolve();
    });
    client.once('connect_error', reject);
  });
}

/** Resolves with the `data` of the handshake `connect_error`. */
function refused(client: Client): Promise<ConnectErrorData> {
  return new Promise((resolve, reject) => {
    client.once('connect', () => {
      reject(new Error('expected the handshake to be refused'));
    });
    client.once('connect_error', (err: Error & { data?: unknown }) => {
      resolve(ConnectErrorData.parse(err.data));
    });
  });
}

/** Records every `session:revoked` and whether the client got disconnected, in order. */
function recordRevocation(client: Client): string[] {
  const events: string[] = [];
  client.on('session:revoked', (payload: SessionRevokedPayload) => events.push(`revoked:${payload.reason}`));
  client.on('disconnect', () => events.push('disconnect'));
  return events;
}

async function userWithSocket(username: string): Promise<{ cookie: string; client: Client }> {
  await insertUser(username);
  const cookie = await login(app, username);
  const client = connect({ cookie });
  await connected(client);
  return { cookie, client };
}

describe('socket handshake', () => {
  it('is refused without a cookie', async () => {
    expect(await refused(connect({}))).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('is refused with a bad cookie', async () => {
    expect(await refused(connect({ cookie: `${SESSION_COOKIE}=not-a-real-token` }))).toEqual({
      code: 'UNAUTHENTICATED',
    });
  });

  it('is refused with a foreign Origin, even with a valid session', async () => {
    await insertUser('alice');
    const cookie = await login(app, 'alice');
    expect(await refused(connect({ cookie, origin: 'http://evil.example' }))).toEqual({ code: 'FORBIDDEN' });
  });

  it('is accepted with a valid session and joins all / user / session rooms', async () => {
    const user = await insertUser('alice');
    const cookie = await login(app, 'alice');
    const client = connect({ cookie });
    await connected(client);

    await waitUntil(() => app.realtime.io.sockets.sockets.size === 1, { message: 'server socket' });
    const [serverSocket] = [...app.realtime.io.sockets.sockets.values()];
    if (serverSocket === undefined) throw new Error('no server socket');
    expect(serverSocket.data.userId).toBe(user.id);
    await waitUntil(() => serverSocket.rooms.size === 4, { message: 'rooms joined' });
    expect([...serverSocket.rooms]).toEqual(
      expect.arrayContaining(['all', `user:${user.id}`, `session:${serverSocket.data.sessionId}`]),
    );
  });
});

describe('a revoke between the handshake and joining the rooms (B.7b rule 7)', () => {
  /** An app whose socket handshake runs `inject` (once) after resolving the session, before the join. */
  async function hookedApp(): Promise<{
    hooked: FastifyInstance;
    url: string;
    injectOnce: (fn: () => Promise<void>) => void;
  }> {
    let pending: (() => Promise<void>) | null = null;
    const hooked = makeApp({
      testHooks: {
        afterSocketHandshakeResolved: async () => {
          const fn = pending;
          pending = null;
          await fn?.();
        },
      },
    });
    await hooked.listen({ host: '127.0.0.1', port: 0 });
    const address = hooked.server.address();
    if (address === null || typeof address === 'string') throw new Error('unexpected server address');
    return {
      hooked,
      url: `http://127.0.0.1:${address.port}`,
      injectOnce: (fn) => {
        pending = fn;
      },
    };
  }

  function connectTo(url: string, cookie: string): Client {
    const client: Client = connectClient(url, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { origin: ORIGIN, cookie },
    });
    clients.push(client);
    return client;
  }

  it('a logout in that window → session:revoked(logout), then disconnect', async () => {
    const { hooked, url, injectOnce } = await hookedApp();
    try {
      await insertUser('alice');
      const cookie = await login(hooked, 'alice');
      injectOnce(async () => {
        expect((await api(hooked, 'POST', '/api/auth/logout', { cookie })).statusCode).toBe(204);
      });
      const client = connectTo(url, cookie);
      const events = recordRevocation(client);
      await waitUntil(() => events.includes('disconnect'), { message: 'disconnect' });
      expect(events).toEqual(['revoked:logout', 'disconnect']);
      await waitUntil(() => hooked.realtime.io.sockets.sockets.size === 0, { message: 'server side closed' });
    } finally {
      await hooked.close();
    }
  });

  it('a deactivation in that window → session:revoked(deactivated), disconnect, and no presence left', async () => {
    const { hooked, url, injectOnce } = await hookedApp();
    try {
      await insertUser('admin', { role: 'admin' });
      const bob = await insertUser('bob');
      const adminCookie = await login(hooked, 'admin');
      const cookie = await login(hooked, 'bob');
      injectOnce(async () => {
        const res = await api(hooked, 'POST', `/api/admin/users/${bob.id}/deactivate`, {
          cookie: adminCookie,
        });
        expect(res.statusCode).toBe(204);
      });
      const client = connectTo(url, cookie);
      const events = recordRevocation(client);
      await waitUntil(() => events.includes('disconnect'), { message: 'disconnect' });
      expect(events).toEqual(['revoked:deactivated', 'disconnect']);
      await waitUntil(() => !hooked.realtime.onlineUserIds().includes(bob.id), { message: 'bob offline' });
    } finally {
      await hooked.close();
    }
  });

  it('with nothing revoked, the socket stays connected', async () => {
    const { hooked, url, injectOnce } = await hookedApp();
    try {
      await insertUser('alice');
      const cookie = await login(hooked, 'alice');
      injectOnce(() => Promise.resolve());
      const client = connectTo(url, cookie);
      const events = recordRevocation(client);
      await connected(client);
      // The re-check is one DB read; give it ample time to (not) act.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events).toEqual([]);
      expect(client.connected).toBe(true);
    } finally {
      await hooked.close();
    }
  });
});

describe('session revocation', () => {
  it('logout emits session:revoked(logout) and disconnects only that session', async () => {
    const { cookie, client } = await userWithSocket('alice');
    const otherCookie = await login(app, 'alice');
    const other = connect({ cookie: otherCookie });
    await connected(other);
    const events = recordRevocation(client);
    const otherEvents = recordRevocation(other);

    expect((await api(app, 'POST', '/api/auth/logout', { cookie })).statusCode).toBe(204);

    await waitUntil(() => events.includes('disconnect'), { message: 'disconnect' });
    expect(events).toEqual(['revoked:logout', 'disconnect']);
    expect(otherEvents).toEqual([]);
    expect(other.connected).toBe(true);

    // Reconnecting with the revoked cookie is refused.
    expect(await refused(connect({ cookie }))).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('changing the password revokes the other sessions (password_changed); the current one stays', async () => {
    const { cookie, client } = await userWithSocket('alice');
    const other = connect({ cookie: await login(app, 'alice') });
    await connected(other);
    const currentEvents = recordRevocation(client);
    const otherEvents = recordRevocation(other);

    const res = await api(app, 'POST', '/api/me/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
    });
    expect(res.statusCode).toBe(204);

    await waitUntil(() => otherEvents.includes('disconnect'), { message: 'other disconnect' });
    expect(otherEvents).toEqual(['revoked:password_changed', 'disconnect']);
    expect(currentEvents).toEqual([]);
    expect(client.connected).toBe(true);
  });

  it('a password reset revokes every session (password_reset)', async () => {
    await insertUser('admin', { role: 'admin' });
    const adminCookie = await login(app, 'admin');
    const { client } = await userWithSocket('bob');
    const events = recordRevocation(client);
    const list = await api(app, 'GET', '/api/users', { cookie: adminCookie });
    const bobId = UsersResponse.parse(list.json()).users.find((u) => u.username === 'bob')?.id ?? '';
    const issued = await api(app, 'POST', `/api/admin/users/${bobId}/reset-code`, { cookie: adminCookie });
    const { code } = ResetCodeResponse.parse(issued.json());

    const res = await api(app, 'POST', '/api/auth/reset-password', {
      body: { username: 'bob', code, newPassword: 'reset password 123' },
    });
    expect(res.statusCode).toBe(204);
    await waitUntil(() => events.includes('disconnect'), { message: 'disconnect' });
    expect(events).toEqual(['revoked:password_reset', 'disconnect']);
  });

  it('the test reset disconnects every socket', async () => {
    const { client } = await userWithSocket('alice');
    const events = recordRevocation(client);
    const res = await api(app, 'POST', '/api/__test__/reset', { headers: { 'x-test-token': TOKEN } });
    expect(res.statusCode).toBe(200);
    await waitUntil(() => events.includes('disconnect'), { message: 'disconnect' });
  });
});

describe('shutdown', () => {
  it('app.close() closes live sockets instead of hanging on them', async () => {
    const { client } = await userWithSocket('alice');
    const events = recordRevocation(client);
    await app.close();
    await waitUntil(() => events.includes('disconnect'), { message: 'disconnect' });
  });
});

describe('broadcasts', () => {
  it('PATCH /me emits user:updated (PublicUser) to room all', async () => {
    const { cookie } = await userWithSocket('alice');
    const { client: bobClient } = await userWithSocket('bob');
    const received: UserUpdatedPayload[] = [];
    bobClient.on('user:updated', (payload) => received.push(payload));

    const res = await api(app, 'PATCH', '/api/me', { cookie, body: { displayName: 'Alice!' } });
    expect(res.statusCode).toBe(200);
    await waitUntil(() => received.length === 1, { message: 'user:updated' });
    expect(received[0]?.user).toMatchObject({ username: 'alice', displayName: 'Alice!', deactivated: false });
    expect(received[0]?.user).not.toHaveProperty('createdAt');
  });
});

describe('onClientEvent', () => {
  it('validates the payload, acks the result, and maps AppError / unexpected errors', async () => {
    const calls: string[] = [];
    app.realtime.io.on('connection', (socket) => {
      onClientEvent(socket, 'typing:start', ({ channelId }) => {
        calls.push(channelId);
        if (channelId === '00000000-0000-4000-8000-000000000001') {
          throw new AppError('FORBIDDEN', 'No access');
        }
        if (channelId === '00000000-0000-4000-8000-000000000002') throw new Error('boom');
        return null;
      });
    });
    const { client } = await userWithSocket('alice');

    const emit = (payload: unknown): Promise<Ack<null>> =>
      new Promise((resolve) => {
        // Deliberately untyped payload: the server must validate whatever arrives.
        client.emit('typing:start', payload as { channelId: string }, resolve);
      });

    const invalid = await emit({ channelId: 'nope' });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await emit({ channelId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      ok: true,
      data: null,
    });
    expect(await emit({ channelId: '00000000-0000-4000-8000-000000000001' })).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'No access' },
    });
    expect(await emit({ channelId: '00000000-0000-4000-8000-000000000002' })).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    // The handler never saw the invalid payload.
    expect(calls).toHaveLength(3);
  });
});
