import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk';
import { LIMITS, voiceRoomName } from '@hearth/shared';
import type { Env } from '../env.js';

/** B.6 grants, identical for admins and members. Moderation goes through the server's RoomServiceClient. */
export function voiceGrant(room: string): VideoGrant {
  return {
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    canPublishSources: [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ],
    roomAdmin: false,
    roomCreate: false,
  };
}

export interface MintedVoiceToken {
  token: string;
  roomName: string;
  /** The token's `exp` claim. */
  expiresAt: Date;
}

/** The `exp` claim (seconds) of a JWT we just signed. */
function expiryOf(jwt: string): Date {
  const payload = jwt.split('.')[1];
  if (payload === undefined) throw new Error('malformed JWT');
  const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const exp: unknown = typeof claims === 'object' && claims !== null ? Reflect.get(claims, 'exp') : undefined;
  if (typeof exp !== 'number') throw new Error('JWT has no exp claim');
  return new Date(exp * 1000);
}

/**
 * CONTRACTS B.6: room `voice_<channelId>`, identity = user id, name = display name, TTL 10 min. Minting is
 * local (no LiveKit call). The caller has already checked that the channel is a voice channel and the user
 * is active.
 */
export async function mintVoiceToken(
  env: Pick<Env, 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET'>,
  input: { channelId: string; userId: string; displayName: string },
): Promise<MintedVoiceToken> {
  const roomName = voiceRoomName(input.channelId);
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: input.userId,
    name: input.displayName,
    ttl: LIMITS.livekitTokenTtlSeconds,
  });
  at.addGrant(voiceGrant(roomName));
  const token = await at.toJwt();
  return { token, roomName, expiresAt: expiryOf(token) };
}
