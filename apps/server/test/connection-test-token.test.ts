import { parseVoiceRoomName } from '@hearth/shared';
import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TEST_IDENTITY,
  CONNECTION_TEST_TTL_SECONDS,
  mintConnectionTestToken,
} from '../src/livekit/connection-test-token.js';
import { testEnv } from './helpers/app.js';
import { TEST_LK_KEY, TEST_LK_SECRET } from './helpers/voice.js';

describe('LiveKit connection-test token', () => {
  const env = testEnv({
    LIVEKIT_PUBLIC_URL: 'wss://lk.example.test',
    LIVEKIT_API_KEY: TEST_LK_KEY,
    LIVEKIT_API_SECRET: TEST_LK_SECRET,
  });

  it('joins a throwaway room only, mic/camera + subscribe, TTL <= 600 s', async () => {
    const minted = await mintConnectionTestToken(env);
    expect(minted.url).toBe('wss://lk.example.test');
    expect(minted.roomName).toMatch(/^connection-test-[0-9a-f]{12}$/);

    const claims = await new TokenVerifier(TEST_LK_KEY, TEST_LK_SECRET).verify(minted.token);
    expect(claims.sub).toBe(CONNECTION_TEST_IDENTITY);
    expect(claims.sub).toBe('connection-test');
    expect(claims.iss).toBe(TEST_LK_KEY);
    expect(claims.exp).toBeDefined();
    expect(claims.nbf).toBeDefined();
    const ttl = (claims.exp ?? 0) - (claims.nbf ?? 0);
    expect(ttl).toBe(CONNECTION_TEST_TTL_SECONDS);
    expect(ttl).toBeLessThanOrEqual(600);
    expect((claims.exp ?? 0) * 1000).toBeLessThanOrEqual(Date.now() + 600_000 + 1_000);
    expect(claims.video).toEqual({
      roomJoin: true,
      room: minted.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: ['microphone', 'camera'],
      roomAdmin: false,
      roomCreate: false,
    });
  });

  it('never targets a Hearth voice room, and each run gets a fresh room', async () => {
    const rooms = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { token } = await mintConnectionTestToken(env);
      const room = (await new TokenVerifier(TEST_LK_KEY, TEST_LK_SECRET).verify(token)).video?.room ?? '';
      expect(room).not.toMatch(/^voice_/);
      expect(parseVoiceRoomName(room)).toBeNull();
      rooms.add(room);
    }
    expect(rooms.size).toBe(20);
  });
});
