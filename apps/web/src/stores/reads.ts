import type { Message, ReadState } from '@hearth/shared';
import { create } from 'zustand';
import { compareMessageIds } from './messages';

/**
 * Unread flags and mention counts per channel (docs/plans/phase-4.md, "Unread logic";
 * CONTRACTS B.5a rule 3).
 *
 * - `server` is the last server-computed `ReadState` (bootstrap, `readstate:updated`, our own
 *   POST `/channels/:id/read`). It is authoritative, and forward-only like the server: a state with
 *   an older `lastReadMessageId` than the current one is stale and ignored.
 * - `seen` holds messages from someone else, seen live after `server.lastReadMessageId` in a channel
 *   we weren't reading. They are the local guess on top of `server`: they make the channel unread
 *   and add their mentions to the count. A newer server state drops the ones it has read, and the
 *   rest are assumed to be included in its counts from then on (`counted`) — but only those received
 *   before that state was requested. Every seen message gets a receive sequence number (`seq`); a
 *   bootstrap snapshot (or a POST response) passes the sequence from when its request started, so a
 *   mention that arrived while it was in flight, possibly after the server computed it, stays on top.
 *   `readstate:updated` events carry no mark: the server computes them right after the write and
 *   emits them on the same socket as `message:created`, so they count everything received before
 *   them (the only gap is a read query overlapping a commit, which needs a server-side cursor).
 */
export interface SeenMessage {
  mentionsMe: boolean;
  /** Receive sequence number (`ReadsState.seq` when it arrived). */
  seq: number;
  /** Arrived before the current `server` state, so its mention is already in `server.mentionCount`. */
  counted: boolean;
}

export interface ChannelRead {
  server: ReadState;
  seen: Record<string, SeenMessage>;
}

export interface ReadsState {
  channels: Record<string, ChannelRead>;
  /** Sequence number of the last seen message (see `SeenMessage.seq`). */
  seq: number;

  /**
   * An authoritative state (`readstate:updated`, the POST response). With `sinceSeq` (the `seq` when
   * its request started), only messages received up to then are taken as included in its counts;
   * without it, every message received so far is.
   */
  applyServer: (readState: ReadState, sinceSeq?: number) => void;
  /** Every state of a bootstrap response (requested at `sinceSeq`, as above). Missing channels are kept. */
  applySnapshot: (readStates: readonly ReadState[], sinceSeq?: number) => void;
  /**
   * A live `message:created` from someone else in a channel we aren't reading (the caller decides
   * that). Our own messages are ignored: sending advances our read state on the server.
   */
  receiveMessage: (message: Message, meId: string) => void;
  /** `message:deleted`: a deleted message no longer counts. */
  removeMessage: (channelId: string, messageId: string) => void;
  forgetChannel: (channelId: string) => void;
  reset: () => void;
}

export interface UnreadSummary {
  unread: boolean;
  mentionCount: number;
}

const NOTHING_UNREAD: UnreadSummary = { unread: false, mentionCount: 0 };

/** What the sidebar shows for a channel. */
export function unreadSummary(entry: ChannelRead | undefined): UnreadSummary {
  if (!entry) return NOTHING_UNREAD;
  const seen = Object.values(entry.seen);
  const extraMentions = seen.filter((s) => s.mentionsMe && !s.counted).length;
  return {
    unread: entry.server.unread || seen.length > 0,
    mentionCount: entry.server.mentionCount + extraMentions,
  };
}

function initialRead(channelId: string): ReadState {
  return { channelId, lastReadMessageId: '0', unread: false, mentionCount: 0 };
}

function sameReadState(a: ReadState, b: ReadState): boolean {
  return (
    a.lastReadMessageId === b.lastReadMessageId && a.unread === b.unread && a.mentionCount === b.mentionCount
  );
}

/**
 * `entry` with the server state `incoming` merged in; `entry` itself when nothing changes. Seen
 * messages with `seq <= countedThrough` become `counted`.
 */
function mergeServer(
  entry: ChannelRead | undefined,
  incoming: ReadState,
  countedThrough: number,
): ChannelRead {
  if (entry && compareMessageIds(incoming.lastReadMessageId, entry.server.lastReadMessageId) < 0) {
    return entry; // stale
  }
  const seen: Record<string, SeenMessage> = {};
  let seenChanged = false;
  for (const [id, message] of Object.entries(entry?.seen ?? {})) {
    if (compareMessageIds(id, incoming.lastReadMessageId) <= 0) {
      seenChanged = true;
      continue;
    }
    const counted = message.counted || message.seq <= countedThrough;
    if (counted !== message.counted) seenChanged = true;
    seen[id] = counted === message.counted ? message : { ...message, counted };
  }
  if (entry && !seenChanged && sameReadState(entry.server, incoming)) return entry;
  return { server: incoming, seen: seenChanged || !entry ? seen : entry.seen };
}

export const useReadsStore = create<ReadsState>()((set) => ({
  channels: {},
  seq: 0,

  applyServer: (readState, sinceSeq) => {
    set((state) => {
      const entry = state.channels[readState.channelId];
      const next = mergeServer(entry, readState, sinceSeq ?? state.seq);
      if (next === entry) return state;
      return { channels: { ...state.channels, [readState.channelId]: next } };
    });
  },

  applySnapshot: (readStates, sinceSeq) => {
    set((state) => {
      let channels: Record<string, ChannelRead> | null = null;
      for (const readState of readStates) {
        const entry = (channels ?? state.channels)[readState.channelId];
        const next = mergeServer(entry, readState, sinceSeq ?? state.seq);
        if (next === entry) continue;
        channels ??= { ...state.channels };
        channels[readState.channelId] = next;
      }
      return channels ? { channels } : state;
    });
  },

  receiveMessage: (message, meId) => {
    if (message.authorId === meId) return;
    set((state) => {
      const { channelId, id } = message;
      const entry = state.channels[channelId] ?? { server: initialRead(channelId), seen: {} };
      if (compareMessageIds(id, entry.server.lastReadMessageId) <= 0 || entry.seen[id]) return state;
      const seq = state.seq + 1;
      const seen = {
        ...entry.seen,
        [id]: { mentionsMe: message.mentionUserIds.includes(meId), seq, counted: false },
      };
      return { seq, channels: { ...state.channels, [channelId]: { ...entry, seen } } };
    });
  },

  removeMessage: (channelId, messageId) => {
    set((state) => {
      const entry = state.channels[channelId];
      if (!entry?.seen[messageId]) return state;
      const seen = { ...entry.seen };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by message id
      delete seen[messageId];
      return { channels: { ...state.channels, [channelId]: { ...entry, seen } } };
    });
  },

  forgetChannel: (channelId) => {
    set((state) => {
      if (!state.channels[channelId]) return state;
      const channels = { ...state.channels };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by channel id
      delete channels[channelId];
      return { channels };
    });
  },

  reset: () => {
    set({ channels: {}, seq: 0 });
  },
}));

/** The sidebar summary for one channel (a hook; re-renders only when that channel changes). */
export function useUnreadSummary(channelId: string): UnreadSummary {
  return unreadSummary(useReadsStore((s) => s.channels[channelId]));
}
