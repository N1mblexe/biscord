/**
 * Against the real LiveKit container (`pnpm infra:up`, http://localhost:7880, keys from the repo .env).
 * The container is shared with the dev (:3000) and e2e (:3100) servers: every room created here is named
 * after a fresh uuid (a channel of `hearth_unit`, or a random "foreign" one) and removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { voiceRoomName } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { RoomServiceClient } from 'livekit-server-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { createLiveKitBackend, ignoreNotFound, type VoiceBackend } from '../src/livekit/client.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, insertUser, login } from './helpers/auth.js';
import { insertChannel } from './helpers/chat.js';
import { closeTestDb, truncateAll } from './helpers/db.js';

const TOKEN = 'unit-test-token';

function realEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (key === undefined || secret === undefined) {
    throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set: copy .env.example to .env');
  }
  return testEnv({
    LIVEKIT_URL: process.env.LIVEKIT_URL ?? 'http://localhost:7880',
    LIVEKIT_API_KEY: key,
    LIVEKIT_API_SECRET: secret,
    HEARTH_TEST_MODE: 'true',
    HEARTH_TEST_TOKEN: TOKEN,
    ...overrides,
  });
}

let env: Env;
let admin: RoomServiceClient;
let backend: VoiceBackend;
const created = new Set<string>();
let app: FastifyInstance | null = null;

async function createRoom(channelId: string): Promise<string> {
  const name = voiceRoomName(channelId);
  created.add(name);
  await admin.createRoom({ name, emptyTimeout: 60 });
  return name;
}

beforeAll(() => {
  env = realEnv();
  admin = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  backend = createLiveKitBackend(env);
});
beforeEach(truncateAll);
afterEach(async () => {
  await app?.close();
  app = null;
  for (const name of created) await ignoreNotFound(admin.deleteRoom(name));
  created.clear();
});
afterAll(closeTestDb);

describe('real LiveKit container', () => {
  it('listRooms / listParticipants / deleteRoom round-trip; 404s are recognised', async () => {
    const room = await createRoom(randomUUID());
    expect(await backend.listRooms()).toContain(room);
    expect(await backend.listParticipants(room)).toEqual([]);
    await backend.deleteRoom(room);
    expect(await backend.listRooms()).not.toContain(room);
    // Gone (or never there): a 404 or a no-op, never another error.
    await ignoreNotFound(backend.deleteRoom(room));
    await ignoreNotFound(backend.removeParticipant(room, randomUUID()));
  });

  it('health is ok with the right keys and down with wrong ones', async () => {
    app = makeApp({ env, voiceBackend: backend });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      status: 'ok',
      db: 'ok',
      livekit: 'ok',
    });
    await app.close();
    const wrong = realEnv({ LIVEKIT_API_SECRET: 'wrong-secret-0123456789abcdef-0123456' });
    app = makeApp({ env: wrong, voiceBackend: createLiveKitBackend(wrong) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'degraded', db: 'ok', livekit: 'down' });
  });

  it('deleting a voice channel deletes its room; the reconcile leaves foreign rooms alone', async () => {
    app = makeApp({ env, voiceBackend: backend });
    await app.ready();
    await insertUser('alice', { role: 'admin' });
    const cookie = await login(app, 'alice');
    const lounge = await insertChannel('lounge', { type: 'voice' });
    const room = await createRoom(lounge.id);
    const foreign = await createRoom(randomUUID());

    await app.voice.reconciler.runNow();
    expect(app.voice.state.snapshot()).toEqual({});

    const res = await api(app, 'DELETE', `/api/channels/${lounge.id}`, { cookie });
    expect(res.statusCode, res.payload).toBe(204);
    const rooms = await backend.listRooms();
    expect(rooms).not.toContain(room);
    expect(rooms).toContain(foreign);
  });

  it("the test reset deletes this DB's rooms only", async () => {
    app = makeApp({ env, voiceBackend: backend });
    await app.ready();
    const lounge = await insertChannel('lounge', { type: 'voice' });
    const games = await insertChannel('games', { type: 'voice' }); // no room: the 404 is fine
    const room = await createRoom(lounge.id);
    const foreign = await createRoom(randomUUID());

    const res = await api(app, 'POST', '/api/__test__/reset', { headers: { 'x-test-token': TOKEN } });
    expect(res.statusCode, res.payload).toBe(200);
    const rooms = await backend.listRooms();
    expect(rooms).not.toContain(room);
    expect(rooms).not.toContain(voiceRoomName(games.id));
    expect(rooms).toContain(foreign);
  });
});
