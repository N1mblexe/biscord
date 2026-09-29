import type { VoiceKickedPayload, VoiceKickedReason } from '@hearth/shared';
import { NOTICES } from '../stores/notice';
import type { VoiceConnectionState } from './session';

/**
 * The app notice for each `voice:kicked` reason (CONTRACTS B.7b rule 4). `deactivated` has none: the
 * `session:revoked` that comes with it sends the user to the login page, which ends voice too.
 */
export const VOICE_KICK_NOTICES: Readonly<Record<VoiceKickedReason, string | null>> = {
  admin: NOTICES.voiceKickedByAdmin,
  channel_deleted: NOTICES.voiceChannelDeleted,
  deactivated: null,
};

export interface VoiceKickContext {
  /** This tab's voice channel (joined or joining), or `null`. */
  channelId: string | null;
  state: VoiceConnectionState;
  /** The last voice channel this tab was in (kept after leaving or being dropped). */
  lastChannelId: string | null;
}

export interface VoiceKickPlan {
  /** Leave the room now (the controller's leave, so the drop isn't reported as a lost connection). */
  leave: boolean;
  /** The app notice to show, or `null`. */
  notice: string | null;
}

/**
 * What a `voice:kicked` means for this tab:
 * - still in (or joining) that channel: leave, and say why;
 * - already out because LiveKit dropped us from that channel first (removeParticipant or deleteRoom
 *   won the race): replace the generic "disconnected" notice with the reason;
 * - anything else (another tab of ours was in voice, or we've since joined another channel): nothing.
 */
export function planVoiceKick(payload: VoiceKickedPayload, ctx: VoiceKickContext): VoiceKickPlan {
  const notice = VOICE_KICK_NOTICES[payload.reason];
  if (notice === null) return { leave: false, notice: null };
  if (ctx.channelId === payload.channelId && ctx.state !== 'disconnected') return { leave: true, notice };
  if (ctx.state === 'disconnected' && ctx.lastChannelId === payload.channelId) {
    return { leave: false, notice };
  }
  return { leave: false, notice: null };
}
