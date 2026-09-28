import { BootstrapResponse } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel, insertDm } from './helpers/chat.js';
import { closeTestDb, truncateAll } from './helpers/db.js';

let app: FastifyInstance;

beforeEach(async () => {
  await truncateAll();
  app = makeApp({ env: testEnv({ LIVEKIT_PUBLIC_URL: 'wss://lk.example.test' }) });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

async function bootstrap(cookie: string): Promise<BootstrapResponse> {
  const res = await api(app, 'GET', '/api/bootstrap', { cookie });
  expect(res.statusCode, res.payload).toBe(200);
  return BootstrapResponse.parse(res.json());
}

describe('GET /api/bootstrap', () => {
  it('401 when anonymous', async () => {
    expectError(await api(app, 'GET', '/api/bootstrap'), 401, 'UNAUTHENTICATED');
  });

  it('matches the shared schema and carries the staged fields', async () => {
    const alice = await insertUser('alice', { role: 'admin' });
    const bob = await insertUser('bob');
    const gone = await insertUser('gone', { deactivated: true });
    const voice = await insertChannel('lounge', { type: 'voice', position: 0 });
    const general = await insertChannel('general', { position: 1 });

    const body = await bootstrap(await login(app, 'alice'));
    expect(body.me).toMatchObject({ id: alice.id, username: 'alice', role: 'admin', deactivated: false });
    expect(body.me.createdAt).toBe(alice.createdAt.toISOString());
    // Every user, deactivated included.
    expect(body.users.map((u) => [u.id, u.deactivated])).toEqual([
      [alice.id, false],
      [bob.id, false],
      [gone.id, true],
    ]);
    // Text and voice channels in one position order, no DMs.
    expect(body.channels).toEqual([
      { id: voice.id, type: 'voice', name: 'lounge', position: 0 },
      { id: general.id, type: 'text', name: 'general', position: 1 },
    ]);
    expect(body).toMatchObject({
      dms: [],
      readStates: [],
      voice: {},
      onlineUserIds: [],
      livekitUrl: 'wss://lk.example.test',
    });
  });

  it('lists DMs only for their members, each with the other member id', async () => {
    const alice = await insertUser('alice');
    const bob = await insertUser('bob');
    const carol = await insertUser('carol');
    const ab = await insertDm(alice.id, bob.id);
    const cb = await insertDm(carol.id, bob.id);

    const forAlice = await bootstrap(await login(app, 'alice'));
    expect(forAlice.dms).toEqual([{ id: ab, type: 'dm', otherUserId: bob.id }]);
    expect(forAlice.channels).toEqual([]);

    const forBob = await bootstrap(await login(app, 'bob'));
    expect(forBob.dms).toEqual([
      { id: ab, type: 'dm', otherUserId: alice.id },
      { id: cb, type: 'dm', otherUserId: carol.id },
    ]);

    const forCarol = await bootstrap(await login(app, 'carol'));
    expect(forCarol.dms).toEqual([{ id: cb, type: 'dm', otherUserId: bob.id }]);
  });
});
