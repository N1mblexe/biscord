import { randomBytes } from 'node:crypto';
import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk';
import type { Env } from '../env.js';

/** Throwaway rooms only; never `voice_*`, so the webhook and reconcile ignore them (parseVoiceRoomName). */
export const CONNECTION_TEST_ROOM_PREFIX = 'connection-test-';
export const CONNECTION_TEST_IDENTITY = 'connection-test';
/** 10 min: long enough to paste the token into https://livekit.io/connection-test and run it. */
export const CONNECTION_TEST_TTL_SECONDS = 10 * 60;

/** Join that one room, publish mic/camera, subscribe. No data, metadata, admin or create. */
export function connectionTestGrant(room: string): VideoGrant {
  return {
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
    roomAdmin: false,
    roomCreate: false,
  };
}

export interface ConnectionTestToken {
  url: string;
  token: string;
  roomName: string;
}

/** Mints locally (no LiveKit call) a token for LiveKit's public connection test. */
export async function mintConnectionTestToken(
  env: Pick<Env, 'LIVEKIT_PUBLIC_URL' | 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET'>,
): Promise<ConnectionTestToken> {
  const roomName = `${CONNECTION_TEST_ROOM_PREFIX}${randomBytes(6).toString('hex')}`;
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: CONNECTION_TEST_IDENTITY,
    ttl: CONNECTION_TEST_TTL_SECONDS,
  });
  at.addGrant(connectionTestGrant(roomName));
  return { url: env.LIVEKIT_PUBLIC_URL, token: await at.toJwt(), roomName };
}
