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
}

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
