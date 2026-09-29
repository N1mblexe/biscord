import { create } from 'zustand';

/**
 * Who is online (CONTRACTS B.5a rule 6): fed by `/bootstrap.onlineUserIds` and `presence` events.
 *
 * A bootstrap response is a snapshot taken at some point during its request, so a `presence` event
 * that arrived while it was in flight may be newer than it. Every event gets a sequence number; a
 * snapshot is applied with the sequence number from when its request started, and events after that
 * are replayed on top of it.
 */
export interface PresenceState {
  /** User ids that are online. */
  online: Record<string, true>;
  /** Sequence number of the last `presence` event. */
  seq: number;
  /** The last `presence` event per user, with its sequence number. */
  lastEvent: Record<string, { seq: number; online: boolean }>;

  /** A `presence` event. */
  setOnline: (userId: string, online: boolean) => void;
  /** A bootstrap snapshot whose request started when `seq` was `sinceSeq`. */
  applySnapshot: (onlineUserIds: readonly string[], sinceSeq: number) => void;
  reset: () => void;
}

const initialState = {
  online: {} as Record<string, true>,
  seq: 0,
  lastEvent: {} as Record<string, { seq: number; online: boolean }>,
};

function withUser(online: Record<string, true>, userId: string, isOnline: boolean): Record<string, true> {
  if ((online[userId] === true) === isOnline) return online;
  const next = { ...online };
  if (isOnline) next[userId] = true;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by user id
  else delete next[userId];
  return next;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  ...initialState,

  setOnline: (userId, isOnline) => {
    set((state) => {
      const seq = state.seq + 1;
      return {
        seq,
        lastEvent: { ...state.lastEvent, [userId]: { seq, online: isOnline } },
        online: withUser(state.online, userId, isOnline),
      };
    });
  },

  applySnapshot: (onlineUserIds, sinceSeq) => {
    set((state) => {
      let online: Record<string, true> = Object.fromEntries(onlineUserIds.map((id) => [id, true as const]));
      for (const [userId, event] of Object.entries(state.lastEvent)) {
        if (event.seq > sinceSeq) online = withUser(online, userId, event.online);
      }
      return { online };
    });
  },

  reset: () => {
    set({ ...initialState });
  },
}));

/** Whether `userId` is online (a hook). */
export function useIsOnline(userId: string | undefined): boolean {
  return usePresenceStore((s) => userId !== undefined && s.online[userId] === true);
}
