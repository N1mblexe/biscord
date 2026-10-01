import { LIMITS } from '@hearth/shared';
import { create } from 'zustand';
import { t } from '../i18n/translate';

/**
 * Who is typing where (CONTRACTS B.5a rule 5): each `typing` event shows the user for
 * `LIMITS.typingExpiryMs` after the last one; a `message:created` from them clears it at once.
 */
export interface TypingState {
  /** Channel id → user ids, in the order they started typing. */
  byChannel: Record<string, readonly string[]>;

  /** A `typing` event: shows `userId` in `channelId` and (re)starts its expiry timer. */
  start: (channelId: string, userId: string) => void;
  /** Hides `userId` in `channelId` (expiry, or a message from them). */
  stop: (channelId: string, userId: string) => void;
  /** Drops a channel (deleted). */
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const timerKey = (channelId: string, userId: string) => `${channelId}:${userId}`;

function clearTimer(key: string): void {
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(key);
}

export const NOBODY_TYPING: readonly string[] = [];

export const useTypingStore = create<TypingState>()((set, get) => ({
  byChannel: {},

  start: (channelId, userId) => {
    const key = timerKey(channelId, userId);
    clearTimer(key);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        get().stop(channelId, userId);
      }, LIMITS.typingExpiryMs),
    );
    set((state) => {
      const users = state.byChannel[channelId] ?? NOBODY_TYPING;
      if (users.includes(userId)) return state;
      return { byChannel: { ...state.byChannel, [channelId]: [...users, userId] } };
    });
  },

  stop: (channelId, userId) => {
    clearTimer(timerKey(channelId, userId));
    set((state) => {
      const users = state.byChannel[channelId];
      if (!users?.includes(userId)) return state;
      return { byChannel: { ...state.byChannel, [channelId]: users.filter((id) => id !== userId) } };
    });
  },

  clearChannel: (channelId) => {
    for (const userId of get().byChannel[channelId] ?? []) clearTimer(timerKey(channelId, userId));
    set((state) => {
      if (!state.byChannel[channelId]) return state;
      const byChannel = { ...state.byChannel };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by channel id
      delete byChannel[channelId];
      return { byChannel };
    });
  },

  reset: () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    set({ byChannel: {} });
  },
}));

/**
 * The typing indicator text (docs/plans/phase-4.md, "Web UI contract") in the UI language; `null`
 * when nobody types.
 */
export function typingText(names: readonly string[]): string | null {
  const [first, second] = names;
  if (first === undefined) return null;
  if (second === undefined) return t('chat.typing.one', { a: first });
  if (names.length === 2) return t('chat.typing.two', { a: first, b: second });
  return t('chat.typing.several');
}
