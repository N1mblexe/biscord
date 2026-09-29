import { create } from 'zustand';

/**
 * The channel whose history is on screen, and whether it is scrolled to the bottom. Set by
 * MessageList; read by the unread inference (socket/chatEvents.ts) and read marking.
 */
export interface ViewingState {
  channelId: string | null;
  atBottom: boolean;
  setViewing: (channelId: string, atBottom: boolean) => void;
  /** The list for `channelId` unmounted (a no-op if another channel took over meanwhile). */
  leave: (channelId: string) => void;
}

export const useViewingStore = create<ViewingState>()((set, get) => ({
  channelId: null,
  atBottom: false,
  setViewing: (channelId, atBottom) => {
    const state = get();
    if (state.channelId === channelId && state.atBottom === atBottom) return;
    set({ channelId, atBottom });
  },
  leave: (channelId) => {
    if (get().channelId === channelId) set({ channelId: null, atBottom: false });
  },
}));

/** `document.visibilityState` right now (`visible` outside a browser). */
export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/**
 * The user is reading `channelId` right now: it is on screen, scrolled to the bottom, and the tab is
 * visible. New messages there are about to be marked read rather than counted as unread.
 */
export function isReadingChannel(channelId: string): boolean {
  const { channelId: viewing, atBottom } = useViewingStore.getState();
  return viewing === channelId && atBottom && isDocumentVisible();
}
