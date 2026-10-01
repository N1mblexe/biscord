import type { VoiceKickedPayload, VoiceKickedReason } from '@hearth/shared';
import { t } from '../i18n/translate';
import type { MessageKey } from '../i18n/types';
import type { VoiceConnectionState } from './session';

const NOTICE_KEYS: Readonly<Record<VoiceKickedReason, MessageKey | null>> = {
  admin: 'voice.kicked.admin',
  channel_deleted: 'voice.kicked.channelDeleted',
  deactivated: null,
};

/**
 * The app notice for a `voice:kicked` reason (CONTRACTS B.7b rule 4), in the current UI language.
 * `deactivated` has none: the `session:revoked` that comes with it sends the user to the login page,
 * which ends voice too.
 */
export function voiceKickNotice(reason: VoiceKickedReason): string | null {
  const key = NOTICE_KEYS[reason];
  return key === null ? null : t(key);
}

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
  const notice = voiceKickNotice(payload.reason);
  if (notice === null) return { leave: false, notice: null };
  if (ctx.channelId === payload.channelId && ctx.state !== 'disconnected') return { leave: true, notice };
  if (ctx.state === 'disconnected' && ctx.lastChannelId === payload.channelId) {
    return { leave: false, notice };
  }
  return { leave: false, notice: null };
}
