import type { Room } from 'livekit-client';
import { createContext, useContext } from 'react';

export interface VoiceActions {
  /** Joins a voice channel (leaving the current one first). */
  join: (channelId: string) => void;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /** **Camera** / **Stop camera**. */
  toggleCamera: () => void;
  /** **Share screen** / **Stop sharing**. */
  toggleScreen: () => void;
  /** Sets and saves `userId`'s local playback volume (0–1). */
  setUserVolume: (userId: string, volume: number) => void;
  /** Resumes audio playback the browser blocked (must run in a click handler). */
  startAudio: () => void;
  /** The on-screen **Push to talk** hold button went down (push-to-talk mode, while connected). */
  pttPress: () => void;
  /** …and up: released after the release delay, like the key. */
  pttRelease: () => void;
}

/** The actions the voice engine implements; VoiceProvider adds push-to-talk itself. */
export type EngineVoiceActions = Omit<VoiceActions, 'pttPress' | 'pttRelease'>;

export const VoiceContext = createContext<VoiceActions | null>(null);

/** Voice actions. Only available inside the protected layout (`<VoiceProvider>`). */
export function useVoice(): VoiceActions {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside <VoiceProvider>');
  return value;
}

/** The app's one LiveKit room (for the video stage). */
export const VoiceRoomContext = createContext<Room | null>(null);

export function useVoiceRoom(): Room {
  const room = useContext(VoiceRoomContext);
  if (!room) throw new Error('useVoiceRoom must be used inside <VoiceProvider>');
  return room;
}
