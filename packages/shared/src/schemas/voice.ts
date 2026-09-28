import { z } from 'zod';
import { IsoDate, Uuid } from '../ids.js';

export const VoiceParticipant = z.object({
  userId: Uuid,
  joinedAt: IsoDate,
  selfMute: z.boolean(),
  selfDeaf: z.boolean(),
  camera: z.boolean(),
  screen: z.boolean(),
});
export type VoiceParticipant = z.infer<typeof VoiceParticipant>;

/** POST `/voice/:channelId/token` */
export const VoiceTokenResponse = z.object({
  token: z.string(),
  url: z.string(),
  roomName: z.string(),
  expiresAt: IsoDate,
});
export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponse>;

const VOICE_ROOM_PREFIX = 'voice_';

/** LiveKit room name for a voice channel (B.6): `voice_<channelId>`. */
export function voiceRoomName(channelId: string): string {
  return `${VOICE_ROOM_PREFIX}${channelId}`;
}

/** Inverse of `voiceRoomName`: the channel id, or `null` if `name` is not a Hearth voice room. */
export function parseVoiceRoomName(name: string): string | null {
  if (!name.startsWith(VOICE_ROOM_PREFIX)) return null;
  const channelId = name.slice(VOICE_ROOM_PREFIX.length);
  return Uuid.safeParse(channelId).success ? channelId : null;
}
