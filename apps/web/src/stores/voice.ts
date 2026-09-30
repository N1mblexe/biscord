import type { VoiceParticipant } from '@hearth/shared';
import { create } from 'zustand';

/**
 * Who is in which voice channel (CONTRACTS B.5, B.6a rule 4): fed by `/bootstrap.voice` and the
 * `voice:joined` / `voice:updated` / `voice:left` events, for every voice channel (joined or not).
 *
 * Same snapshot/sequence scheme as the presence store: every event gets a sequence number, a
 * bootstrap snapshot is applied with the sequence number from when its request started, and the
 * events after that are replayed on top of it in order.
 *
 * A user is listed in at most one channel: a join or update in one channel removes them from any
 * other (the server's `voice:left` for the old room may arrive later, and is then a no-op).
 */

export type VoiceEvent =
  | { type: 'joined' | 'updated'; channelId: string; participant: VoiceParticipant }
  | { type: 'left'; channelId: string; userId: string };

type ByChannel = Record<string, readonly VoiceParticipant[]>;

export interface VoiceParticipantsState {
  /** Voice channel id → participants, ordered by `joinedAt` (then user id). */
  byChannel: ByChannel;
  /** Sequence number of the last voice event. */
  seq: number;
  /** The last event per `channelId:userId`, with its sequence number (for snapshot replay). */
  lastEvent: Record<string, { seq: number; event: VoiceEvent }>;
  /**
   * Tombstones: deleted channel id → the sequence number of its `forgetChannel`, so a snapshot
   * requested before the delete can't bring its participants back.
   */
  forgotten: Record<string, number>;

  /** A `voice:*` event. */
  apply: (event: VoiceEvent) => void;
  /** A bootstrap snapshot whose request started when `seq` was `sinceSeq`. */
  applySnapshot: (voice: Readonly<Record<string, readonly VoiceParticipant[]>>, sinceSeq: number) => void;
  /** Drops a channel (deleted). */
  forgetChannel: (channelId: string) => void;
  reset: () => void;
}

export const NOBODY_IN_VOICE: readonly VoiceParticipant[] = [];

function byJoinOrder(a: VoiceParticipant, b: VoiceParticipant): number {
  if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

function withoutUser(byChannel: ByChannel, userId: string, onlyChannel?: string): ByChannel {
  let next = byChannel;
  for (const [channelId, list] of Object.entries(byChannel)) {
    if (onlyChannel !== undefined && channelId !== onlyChannel) continue;
    if (!list.some((p) => p.userId === userId)) continue;
    if (next === byChannel) next = { ...byChannel };
    const rest = list.filter((p) => p.userId !== userId);
    if (rest.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by channel id
      delete next[channelId];
    } else {
      next[channelId] = rest;
    }
  }
  return next;
}

/** Pure reducer: `byChannel` after `event`. Unchanged input is returned as is. */
export function reduceVoice(byChannel: ByChannel, event: VoiceEvent): ByChannel {
  if (event.type === 'left') return withoutUser(byChannel, event.userId, event.channelId);
  const { channelId, participant } = event;
  const existing = byChannel[channelId]?.find((p) => p.userId === participant.userId);
  if (
    existing &&
    existing.joinedAt === participant.joinedAt &&
    existing.selfMute === participant.selfMute &&
    existing.selfDeaf === participant.selfDeaf &&
    existing.camera === participant.camera &&
    existing.screen === participant.screen
  ) {
    return withoutUserElsewhere(byChannel, participant.userId, channelId);
  }
  const next = { ...withoutUser(byChannel, participant.userId) };
  next[channelId] = [...(next[channelId] ?? []), participant].sort(byJoinOrder);
  return next;
}

function withoutUserElsewhere(byChannel: ByChannel, userId: string, keepChannel: string): ByChannel {
  let next = byChannel;
  for (const channelId of Object.keys(byChannel)) {
    if (channelId !== keepChannel) next = withoutUser(next, userId, channelId);
  }
  return next;
}

function snapshotToByChannel(voice: Readonly<Record<string, readonly VoiceParticipant[]>>): ByChannel {
  // Each user once, in the channel with their latest join (defensive: the server lists one each).
  let byChannel: ByChannel = {};
  const all = Object.entries(voice)
    .flatMap(([channelId, list]) => list.map((participant) => ({ channelId, participant })))
    .sort((a, b) => byJoinOrder(a.participant, b.participant));
  for (const { channelId, participant } of all) {
    byChannel = reduceVoice(byChannel, { type: 'joined', channelId, participant });
  }
  return byChannel;
}

function eventKey(event: VoiceEvent): string {
  const userId = event.type === 'left' ? event.userId : event.participant.userId;
  return `${event.channelId}:${userId}`;
}

function withoutChannel(byChannel: ByChannel, channelId: string): ByChannel {
  if (!(channelId in byChannel)) return byChannel;
  const next = { ...byChannel };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by channel id
  delete next[channelId];
  return next;
}

const initialState = {
  byChannel: {} as ByChannel,
  seq: 0,
  lastEvent: {} as Record<string, { seq: number; event: VoiceEvent }>,
  forgotten: {} as Record<string, number>,
};

export const useVoiceStore = create<VoiceParticipantsState>()((set) => ({
  ...initialState,

  apply: (event) => {
    set((state) => {
      const seq = state.seq + 1;
      return {
        seq,
        lastEvent: { ...state.lastEvent, [eventKey(event)]: { seq, event } },
        byChannel: reduceVoice(state.byChannel, event),
      };
    });
  },

  applySnapshot: (voice, sinceSeq) => {
    set((state) => {
      let byChannel = snapshotToByChannel(voice);
      // Events and channel deletions since the request started, replayed in order.
      const newer: { seq: number; apply: (b: ByChannel) => ByChannel }[] = [
        ...Object.values(state.lastEvent).map(({ seq, event }) => ({
          seq,
          apply: (b: ByChannel) => reduceVoice(b, event),
        })),
        ...Object.entries(state.forgotten).map(([channelId, seq]) => ({
          seq,
          apply: (b: ByChannel) => withoutChannel(b, channelId),
        })),
      ]
        .filter((e) => e.seq > sinceSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const { apply } of newer) byChannel = apply(byChannel);
      return { byChannel };
    });
  },

  forgetChannel: (channelId) => {
    set((state) => {
      const seq = state.seq + 1;
      return {
        seq,
        forgotten: { ...state.forgotten, [channelId]: seq },
        byChannel: withoutChannel(state.byChannel, channelId),
      };
    });
  },

  reset: () => {
    set({ ...initialState });
  },
}));

/** The participants of voice channel `channelId` (a hook). */
export function useVoiceParticipants(channelId: string): readonly VoiceParticipant[] {
  return useVoiceStore((s) => s.byChannel[channelId] ?? NOBODY_IN_VOICE);
}
