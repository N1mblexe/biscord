import type { Message, Reaction } from '@hearth/shared';
import { create } from 'zustand';

/**
 * Normalized message store (docs/plans/phase-3.md, "Web state").
 *
 * - One entry per channel that has been opened (or is being opened): sorted ids + messages by id.
 * - Every write is an idempotent upsert by id, so the REST response, the `message:created` event and
 *   reconnect catch-up can arrive in any order and in any number without duplicating anything.
 * - Optimistic sends live in `pending`, keyed by the nonce echoed back on the real message; any
 *   upsert of a message carrying that nonce replaces the optimistic copy.
 * - Deleted ids are remembered (`tombstones`) so a stale page or late event can't resurrect them.
 * - Loaded ids never have a hole: everything between `ids[0]` and the newest loaded id is present,
 *   so `before=ids[0]` always pages the rest. A live insert older than `ids[0]` (while `hasOlder`)
 *   is dropped, `message:updated` only touches ids already present, and a latest page with more
 *   history behind it drops loaded ids older than itself.
 * - `syncedThrough` is the reconnect catch-up cursor: every message up to it is known to be in the
 *   store (or tombstoned). It only advances through the latest page, `?after=` catch-up pages and
 *   live socket events — never through our own REST send, which can overtake missed messages.
 */

export interface ChannelMessages {
  /** Ascending by id (numeric order; ids are bigints as decimal strings). */
  ids: string[];
  byId: Record<string, Message>;
  /** There may be messages older than `ids[0]` on the server. */
  hasOlder: boolean;
  /** The latest page has been fetched; until then the entry only buffers live events. */
  loaded: boolean;
  /** Catch-up cursor (see above); `null` until a non-empty latest page or catch-up page arrives. */
  syncedThrough: string | null;
  /**
   * The socket connection epoch (lib/messageSync.ts) in which `syncedThrough` became contiguous with
   * live delivery; only then may live events advance it. `null` = not live.
   */
  liveEpoch: number | null;
}

export type PendingStatus = 'sending' | 'failed';

export interface PendingMessage {
  nonce: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: string;
  status: PendingStatus;
}

export interface MessagesState {
  channels: Record<string, ChannelMessages>;
  /** Optimistic sends by nonce, in send order. */
  pending: Record<string, PendingMessage>;
  tombstones: Record<string, true>;

  /** Creates an empty, not-yet-loaded entry so live events are buffered while the first page loads. */
  ensureChannel: (channelId: string) => void;
  /**
   * Merges the latest page and marks the channel loaded; advances `syncedThrough` to its newest id.
   * With `hasOlder`, loaded ids older than the page are dropped (they could leave a hole).
   */
  loadLatest: (channelId: string, messages: readonly Message[], hasOlder: boolean) => void;
  /** Merges a contiguous page (older history or catch-up); inserts every id. */
  upsertMany: (channelId: string, messages: readonly Message[]) => void;
  /**
   * A new message (`message:created`, our own REST send): inserted unless it is older than the
   * oldest loaded id while there is unloaded history (it would punch a hole in the list).
   */
  upsert: (message: Message) => void;
  /** An edited message (`message:updated`, our own edit): replaces it only if it is already loaded. */
  updateIfPresent: (message: Message) => void;
  /**
   * Adds or removes `userId`'s `emoji` reaction on a loaded message (`reaction:added` / `removed`,
   * and optimistic toggles). Idempotent; does nothing for a message that isn't loaded. Returns
   * whether the store changed.
   */
  applyReaction: (
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
    added: boolean,
  ) => boolean;
  /** Moves `syncedThrough` forward to `messageId` (never backwards). */
  advanceSynced: (channelId: string, messageId: string) => void;
  /** Sets `liveEpoch` (see `ChannelMessages`). */
  setLiveEpoch: (channelId: string, epoch: number | null) => void;
  remove: (channelId: string, messageId: string) => void;
  setHasOlder: (channelId: string, hasOlder: boolean) => void;
  /** Drops a channel's entry (channel deleted or no longer accessible). */
  forgetChannel: (channelId: string) => void;

  addPending: (pending: Omit<PendingMessage, 'status'>) => void;
  /** The REST response for a send: upserts the real message and drops the optimistic copy. */
  resolvePending: (nonce: string, message: Message) => void;
  failPending: (nonce: string) => void;
  retryPending: (nonce: string) => void;
  discardPending: (nonce: string) => void;

  reset: () => void;
}

/**
 * `reactions` with `userId`'s `emoji` added or removed; the same array when nothing changes.
 * Order follows the server (CONTRACTS B.5a rule 4): a new emoji goes last, a new user goes last,
 * and an emoji without users disappears.
 */
export function applyReactionChange(
  reactions: readonly Reaction[],
  emoji: string,
  userId: string,
  added: boolean,
): readonly Reaction[] {
  const index = reactions.findIndex((r) => r.emoji === emoji);
  const current = reactions[index];
  if (added) {
    if (!current) return [...reactions, { emoji, userIds: [userId] }];
    if (current.userIds.includes(userId)) return reactions;
    return reactions.with(index, { emoji, userIds: [...current.userIds, userId] });
  }
  if (!current?.userIds.includes(userId)) return reactions;
  const userIds = current.userIds.filter((id) => id !== userId);
  return userIds.length === 0 ? reactions.toSpliced(index, 1) : reactions.with(index, { emoji, userIds });
}

/** Numeric order for bigint ids as decimal strings without leading zeros. */
export function compareMessageIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyChannel(): ChannelMessages {
  return { ids: [], byId: {}, hasOlder: false, loaded: false, syncedThrough: null, liveEpoch: null };
}

function maxId(a: string | null, b: string | null | undefined): string | null {
  if (b === null || b === undefined) return a;
  return a === null || compareMessageIds(b, a) > 0 ? b : a;
}

/**
 * How a merge treats ids that aren't loaded yet:
 * - `all`: insert (contiguous pages);
 * - `live`: insert unless older than `ids[0]` while `hasOlder` (new messages);
 * - `present`: never insert (edits).
 */
type InsertMode = 'all' | 'live' | 'present';

function mayInsert(entry: ChannelMessages, id: string, mode: InsertMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'present') return false;
  const oldest = entry.ids[0];
  return !entry.hasOlder || oldest === undefined || compareMessageIds(id, oldest) > 0;
}

/** Keep an existing copy that was edited later than the incoming one (a stale page or event). */
function isStale(existing: Message | undefined, incoming: Message): boolean {
  if (!existing?.editedAt) return false;
  return incoming.editedAt === null || incoming.editedAt < existing.editedAt;
}

function mergeMessages(
  entry: ChannelMessages,
  messages: readonly Message[],
  tombstones: Record<string, true>,
  mode: InsertMode,
): ChannelMessages {
  let byId: Record<string, Message> | null = null;
  let added = false;
  for (const message of messages) {
    if (tombstones[message.id]) continue;
    const current = (byId ?? entry.byId)[message.id];
    if (current === message || isStale(current, message)) continue;
    if (!current && !mayInsert(entry, message.id, mode)) continue;
    byId ??= { ...entry.byId };
    byId[message.id] = message;
    if (!current) added = true;
  }
  if (!byId) return entry;
  const ids = added ? Object.keys(byId).sort(compareMessageIds) : entry.ids;
  return { ...entry, ids, byId };
}

/** `pending` without the entries whose nonce appears on one of `messages`. */
function withoutNonces(
  pending: Record<string, PendingMessage>,
  messages: readonly Message[],
): Record<string, PendingMessage> {
  let next: Record<string, PendingMessage> | null = null;
  for (const { nonce } of messages) {
    if (nonce !== null && Object.hasOwn(next ?? pending, nonce)) {
      next ??= { ...pending };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by nonce
      delete next[nonce];
    }
  }
  return next ?? pending;
}

const initialState = {
  channels: {} as Record<string, ChannelMessages>,
  pending: {} as Record<string, PendingMessage>,
  tombstones: {} as Record<string, true>,
};

export const useMessageStore = create<MessagesState>()((set, get) => {
  const upsertInto = (
    channelId: string,
    messages: readonly Message[],
    mode: InsertMode,
    patch?: (entry: ChannelMessages) => ChannelMessages,
  ) => {
    set((state) => {
      const entry = state.channels[channelId] ?? emptyChannel();
      const merged = mergeMessages(entry, messages, state.tombstones, mode);
      const next = patch ? patch(merged) : merged;
      const pending = withoutNonces(state.pending, messages);
      if (next === state.channels[channelId] && pending === state.pending) return state;
      return { channels: { ...state.channels, [channelId]: next }, pending };
    });
  };

  const updatePending = (nonce: string, fn: (p: PendingMessage) => PendingMessage | null) => {
    set((state) => {
      const current = state.pending[nonce];
      if (!current) return state;
      const updated = fn(current);
      const pending = { ...state.pending };
      if (updated) pending[nonce] = updated;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by nonce
      else delete pending[nonce];
      return { pending };
    });
  };

  return {
    ...initialState,

    ensureChannel: (channelId) => {
      if (get().channels[channelId]) return;
      set((state) => ({ channels: { ...state.channels, [channelId]: emptyChannel() } }));
    },

    loadLatest: (channelId, messages, hasOlder) => {
      const first = messages[0]?.id;
      upsertInto(channelId, messages, 'all', (entry) => {
        let { ids, byId } = entry;
        if (hasOlder && first !== undefined && ids[0] !== first) {
          ids = ids.filter((id) => compareMessageIds(id, first) >= 0);
          byId = Object.fromEntries(Object.entries(byId).filter(([id]) => compareMessageIds(id, first) >= 0));
        }
        const syncedThrough = maxId(entry.syncedThrough, messages.at(-1)?.id);
        return { ...entry, ids, byId, loaded: true, hasOlder, syncedThrough };
      });
    },

    upsertMany: (channelId, messages) => {
      upsertInto(channelId, messages, 'all');
    },

    upsert: (message) => {
      upsertInto(message.channelId, [message], 'live');
    },

    updateIfPresent: (message) => {
      if (!get().channels[message.channelId]?.byId[message.id]) return;
      upsertInto(message.channelId, [message], 'present');
    },

    applyReaction: (channelId, messageId, emoji, userId, added) => {
      let changed = false;
      set((state) => {
        const entry = state.channels[channelId];
        const message = entry?.byId[messageId];
        if (!entry || !message) return state;
        const reactions = applyReactionChange(message.reactions, emoji, userId, added);
        if (reactions === message.reactions) return state;
        changed = true;
        const byId = { ...entry.byId, [messageId]: { ...message, reactions: [...reactions] } };
        return { channels: { ...state.channels, [channelId]: { ...entry, byId } } };
      });
      return changed;
    },

    advanceSynced: (channelId, messageId) => {
      set((state) => {
        const entry = state.channels[channelId];
        if (!entry) return state;
        const syncedThrough = maxId(entry.syncedThrough, messageId);
        if (syncedThrough === entry.syncedThrough) return state;
        return { channels: { ...state.channels, [channelId]: { ...entry, syncedThrough } } };
      });
    },

    setLiveEpoch: (channelId, liveEpoch) => {
      set((state) => {
        const entry = state.channels[channelId];
        if (!entry || entry.liveEpoch === liveEpoch) return state;
        return { channels: { ...state.channels, [channelId]: { ...entry, liveEpoch } } };
      });
    },

    remove: (channelId, messageId) => {
      set((state) => {
        const tombstones = state.tombstones[messageId]
          ? state.tombstones
          : { ...state.tombstones, [messageId]: true as const };
        const entry = state.channels[channelId];
        if (!entry?.byId[messageId]) return { tombstones };
        const byId = { ...entry.byId };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by message id
        delete byId[messageId];
        const ids = entry.ids.filter((id) => id !== messageId);
        return { tombstones, channels: { ...state.channels, [channelId]: { ...entry, ids, byId } } };
      });
    },

    setHasOlder: (channelId, hasOlder) => {
      set((state) => {
        const entry = state.channels[channelId];
        if (!entry || entry.hasOlder === hasOlder) return state;
        return { channels: { ...state.channels, [channelId]: { ...entry, hasOlder } } };
      });
    },

    forgetChannel: (channelId) => {
      set((state) => {
        if (!state.channels[channelId]) return state;
        const channels = { ...state.channels };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by channel id
        delete channels[channelId];
        const pending = Object.fromEntries(
          Object.entries(state.pending).filter(([, p]) => p.channelId !== channelId),
        );
        return { channels, pending };
      });
    },

    addPending: (pending) => {
      set((state) => ({ pending: { ...state.pending, [pending.nonce]: { ...pending, status: 'sending' } } }));
    },

    resolvePending: (nonce, message) => {
      // upsertInto drops the pending entry through the echoed nonce; drop it explicitly as well in
      // case the server didn't echo it.
      upsertInto(message.channelId, [message], 'live');
      updatePending(nonce, () => null);
    },

    failPending: (nonce) => {
      updatePending(nonce, (p) => ({ ...p, status: 'failed' }));
    },

    retryPending: (nonce) => {
      updatePending(nonce, (p) => ({ ...p, status: 'sending' }));
    },

    discardPending: (nonce) => {
      updatePending(nonce, () => null);
    },

    reset: () => {
      set({ ...initialState });
    },
  };
});
