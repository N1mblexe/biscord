import { createContext, useContext } from 'react';

export interface VoiceActions {
  /** Joins a voice channel (leaving the current one first). */
  join: (channelId: string) => void;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
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
