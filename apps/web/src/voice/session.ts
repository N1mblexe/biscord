import { create } from 'zustand';

/**
 * This tab's own voice session (docs/plans/phase-6.md, "Key decisions → Web"): which channel we
 * are in, the LiveKit connection phase, and the local mute/deafen state. Mute and deafen persist
 * across channel switches within a session; everything resets on logout.
 */

/** `disconnected` = not in voice; the voice panel shows the other three as `data-state`. */
export type VoiceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface MicState {
  /** Our microphone is muted (always true while deafened). */
  micMuted: boolean;
  deafened: boolean;
  /** `micMuted` from right before deafening; undeafen restores it. */
  mutedBeforeDeafen: boolean;
}

/**
 * Mute button: while deafened, un-muting also undeafens (the mic can't be live while deafened);
 * otherwise it just flips the mic.
 */
export function toggleMute(s: MicState): MicState {
  if (s.deafened) return { micMuted: false, deafened: false, mutedBeforeDeafen: false };
  return { ...s, micMuted: !s.micMuted };
}

/** Deafen self-mutes and remembers the mic state; undeafen restores it. */
export function toggleDeafen(s: MicState): MicState {
  if (s.deafened) return { micMuted: s.mutedBeforeDeafen, deafened: false, mutedBeforeDeafen: false };
  return { micMuted: true, deafened: true, mutedBeforeDeafen: s.micMuted };
}

/**
 * Our camera or screen share (docs/plans/phase-7.md): `starting` while the browser asks for the
 * device or picker and LiveKit publishes, `stopping` while it unpublishes. Only `on` counts as
 * publishing for the `voice:state` flags; the panel buttons are disabled while starting or stopping.
 */
export type PublishState = 'off' | 'starting' | 'on' | 'stopping';

/** Camera and screen share both off (leaving or losing the room unpublishes everything). */
export const MEDIA_OFF = { camera: 'off', screen: 'off' } as const satisfies {
  camera: PublishState;
  screen: PublishState;
};

export interface VoiceSessionState extends MicState {
  /** The voice channel we are in or joining, or `null`. */
  channelId: string | null;
  /** LiveKit room name (`voice_<channelId>`) once a token is issued. */
  roomName: string | null;
  state: VoiceConnectionState;
  /** False when the browser blocked audio playback (autoplay policy): show **Click to enable audio**. */
  canPlaybackAudio: boolean;
  /** LiveKit identities (= user ids) in our room that LiveKit reports as active speakers. */
  speaking: Record<string, true>;
  /** Identities in our room whose audio level says they are speaking (voice/speakingMeter.ts). */
  levelSpeaking: Record<string, true>;
  camera: PublishState;
  screen: PublishState;
  /** The **Share tab audio** checkbox (default on): ask the browser for tab audio when sharing. */
  shareTabAudio: boolean;

  set: (patch: Partial<Omit<VoiceSessionState, 'set' | 'reset'>>) => void;
  reset: () => void;
}

const initialState = {
  channelId: null as string | null,
  roomName: null as string | null,
  state: 'disconnected' as VoiceConnectionState,
  micMuted: false,
  deafened: false,
  mutedBeforeDeafen: false,
  canPlaybackAudio: true,
  speaking: {} as Record<string, true>,
  levelSpeaking: {} as Record<string, true>,
  camera: 'off' as PublishState,
  screen: 'off' as PublishState,
  shareTabAudio: true,
};

export const useVoiceSession = create<VoiceSessionState>()((set) => ({
  ...initialState,
  set: (patch) => {
    set(patch);
  },
  reset: () => {
    set({ ...initialState });
  },
}));

/** Whether `userId` is speaking in our own room (a hook; always false for other rooms). */
export function useIsSpeakingInMyRoom(userId: string): boolean {
  return useVoiceSession((s) => s.speaking[userId] === true || s.levelSpeaking[userId] === true);
}

/** The mounted VoiceProvider's leave, so ending the session can drop voice at once. */
let activeLeave: (() => void) | null = null;

/** Called by VoiceProvider; returns the unregister function. */
export function registerVoiceLeave(leave: () => void): () => void {
  activeLeave = leave;
  return () => {
    if (activeLeave === leave) activeLeave = null;
  };
}

/** Logout, revoked or dead session: leave the room now and forget mute/deafen. */
export function endVoiceSession(): void {
  activeLeave?.();
  useVoiceSession.getState().reset();
}
