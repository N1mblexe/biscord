import { create } from 'zustand';

/**
 * The app-wide notice (`data-testid="app-notice"`), e.g. "This channel was deleted.".
 * Set right before sending the user to `/`; the `/` loader then stays on `/` so the notice is seen,
 * and opening a channel clears it.
 */
interface NoticeState {
  notice: string | null;
  setNotice: (notice: string) => void;
  clearNotice: () => void;
}

export const useNoticeStore = create<NoticeState>()((set) => ({
  notice: null,
  setNotice: (notice) => {
    set({ notice });
  },
  clearNotice: () => {
    set({ notice: null });
  },
}));

export const NOTICES = {
  channelDeleted: 'This channel was deleted.',
  channelUnavailable: "That channel doesn't exist or you don't have access to it.",
  voiceNotYet: 'Voice channels arrive soon.',
} as const;
