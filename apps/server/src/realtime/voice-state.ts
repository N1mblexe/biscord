import type { FastifyBaseLogger } from 'fastify';
import { voiceRoomName, type VoiceParticipant, type VoiceStatePayload } from '@hearth/shared';
import { AppError, loggableError } from '../lib/errors.js';
import { ignoreNotFound, type VoiceBackend } from '../livekit/client.js';
import { onClientEvent, type Realtime } from './io.js';

/** Self-reported flags from `voice:state`. */
export type VoiceFlags = Pick<VoiceParticipant, 'selfMute' | 'selfDeaf' | 'camera' | 'screen'>;

const DEFAULT_FLAGS: VoiceFlags = { selfMute: false, selfDeaf: false, camera: false, screen: false };

/** B.6a rule 3: the last 1000 webhook event ids are remembered. Also the size of the left-sid memory. */
export const WEBHOOK_ID_CACHE_SIZE = 1000;

/** `voice:state` flood guard: at most this many events per user per window; the excess is RATE_LIMITED. */
export const VOICE_STATE_BUCKET_MAX = 20;
export const VOICE_STATE_BUCKET_WINDOW_MS = 5_000;

/**
 * B.9 rule 8: a `participant_left` caused by a lost connection is applied only after this grace; a join of
 * the same user in the same room within it is a reconnect (same membership and flags, no leave/join).
 */
export const VOICE_REJOIN_GRACE_MS = 5_000;

/** Which of camera / screen share a participant publishes, according to LiveKit (B.6b rule 1). */
export interface PublishedMedia {
  camera: boolean;
  screen: boolean;
}

/** A participant LiveKit reports (webhook or reconcile). */
export interface ObservedParticipant {
  userId: string;
  /** LiveKit participant sid: one per connection. */
  sid: string;
  joinedAt: Date;
  /** Its published tracks, when known (reconcile only); used to clear stale `camera`/`screen` flags. */
  media?: PublishedMedia;
}

/** What LiveKit says is connected: channel id → user id → participant (one channel per user). */
export type DesiredVoiceState = Map<string, Map<string, ObservedParticipant>>;

interface Entry {
  participant: VoiceParticipant;
  sid: string;
  /** Value of the mutation counter when this membership was last written (see `mark`). */
  seq: number;
}

/** The last `voice:state` a user sent, with the mutation counter when it arrived. */
interface StoredClientState {
  payload: VoiceStatePayload;
  seq: number;
}

/** A bounded insertion-ordered map: setting beyond `capacity` forgets the oldest key. */
class BoundedMap<V> {
  private readonly items = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  get(key: string): V | undefined {
    return this.items.get(key);
  }

  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    if (this.items.size > this.capacity) {
      const oldest = this.items.keys().next();
      if (oldest.done !== true) this.items.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

/**
 * CONTRACTS B.6/B.6a: who is in which voice channel, kept in memory and fed by LiveKit webhooks, the
 * reconcile loop and `voice:state`. Every membership change emits `voice:joined` / `voice:left` to `all`;
 * flag changes emit `voice:updated`. Mutations are synchronous; callers that await something first (a DB
 * check) run inside `exclusive` so webhooks, reconcile passes and resets apply one at a time, in order.
 */
export interface VoiceState {
  /** Runs `fn` after every earlier `exclusive` task has settled; tasks never overlap. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * Runs `apply` for webhook event `id` unless that id was already applied successfully ('duplicate').
   * An id is remembered only once its handling succeeded: a copy arriving while the first is still being
   * handled waits for it, and handles the event itself if the first failed (so a retry that LiveKit got
   * a 200 for is never lost). A failure rejects. Empty ids always run.
   */
  processEvent(id: string, apply: () => Promise<void>): Promise<'applied' | 'duplicate'>;
  /**
   * `participant_joined`. A stale join (its sid already left) is ignored. If the user is in another channel,
   * the most recent join wins: the other room gets a `removeParticipant` (B.6a rule 5).
   */
  participantJoined(channelId: string, participant: ObservedParticipant): void;
  /**
   * `participant_left` / `participant_connection_aborted`; ignored unless `sid` is the current connection.
   * With `graceful` (a lost connection, not a deliberate leave or a removal) the leave is applied only
   * after the rejoin grace (B.9 rule 8): until then the user stays listed with their flags, and a join of
   * the same user in the same room within it continues the membership without any broadcast.
   */
  participantLeft(channelId: string, userId: string, sid: string, graceful?: boolean): void;
  /** `room_finished`: everyone in the channel leaves. */
  roomFinished(channelId: string): void;
  /**
   * `voice:state`: stored per user; applied (→ `voice:updated`) only while the user is in that channel,
   * otherwise throws VALIDATION. A stored state is used as the initial flags when the join arrives later.
   */
  setClientState(userId: string, state: VoiceStatePayload): VoiceParticipant;
  /** Non-empty channels → participants sorted by join time (`/bootstrap.voice`). */
  snapshot(): Record<string, VoiceParticipant[]>;
  /** The mutation counter now; a reconcile pass leaves alone anything written after it. */
  mark(): number;
  /**
   * Makes memory match `desired` (LiveKit's view, already limited to this DB's voice channels), except
   * for memberships written after `since` and sids that left after `since`. A sid tombstoned before `since`
   * but still listed by LiveKit is live: LiveKit's listing is newer than the tombstone. Emits joined/left.
   * B.6b rule 1: a `camera`/`screen` flag whose track LiveKit doesn't list (`media`) is cleared, emitting
   * `voice:updated`, unless the client's `voice:state` carrying it arrived after `since` (the track may not
   * be published yet). Flags are only ever cleared here, never set.
   */
  reconcile(desired: DesiredVoiceState, since: number): void;
  /** The channel the user is in and its LiveKit connection sid, or `null` (B.7b rule 4, B.7 deactivate). */
  membershipOf(userId: string): { channelId: string; sid: string } | null;
  /** User ids in a channel (the occupants to notify when it is deleted), sorted. */
  participantIds(channelId: string): string[];
  /** Drops a channel's participants without emitting (the channel was deleted; `channel:deleted` follows). */
  forgetChannel(channelId: string): void;
  /** Forgets everything, including the webhook id cache, without emitting (test reset). */
  clear(): void;
  /** Cancels pending grace timers (app shutdown). */
  close(): void;
}

export interface VoiceStateDeps {
  realtime: Realtime;
  backend: VoiceBackend;
  log: FastifyBaseLogger;
  /** Default `VOICE_REJOIN_GRACE_MS`; tests shorten it. */
  rejoinGraceMs?: number;
}

/** A graceful leave waiting out the rejoin grace. */
interface PendingLeave {
  sid: string;
  timer: NodeJS.Timeout;
}

export function createVoiceState({
  realtime,
  backend,
  log,
  rejoinGraceMs = VOICE_REJOIN_GRACE_MS,
}: VoiceStateDeps): VoiceState {
  /** channel id → user id → entry. */
  const rooms = new Map<string, Map<string, Entry>>();
  /** user id → the channel id they are in (the one-channel rule keeps this a function). */
  const userChannel = new Map<string, string>();
  /** user id → the last `voice:state` they sent. */
  const clientStates = new Map<string, StoredClientState>();
  const seenEvents = new BoundedMap<true>(WEBHOOK_ID_CACHE_SIZE);
  /** Webhook event id → its handling in progress (copies wait for it). */
  const eventsInFlight = new Map<string, Promise<void>>();
  /** user id → a graceful leave waiting out the rejoin grace (the user is still listed meanwhile). */
  const pendingLeaves = new Map<string, PendingLeave>();
  /**
   * Tombstones: sid → the mutation counter when it was marked as left (or superseded). A sid never
   * reconnects, so a later join webhook for one is stale. Reconcile only honours tombstones newer than its
   * `since` mark: a connection LiveKit lists after an older tombstone is live after all.
   */
  const leftSids = new BoundedMap<number>(WEBHOOK_ID_CACHE_SIZE);
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const tombstone = (sid: string): void => {
    seq += 1;
    leftSids.set(sid, seq);
  };

  const entryOf = (channelId: string, userId: string): Entry | undefined => rooms.get(channelId)?.get(userId);

  /** Drops the user's pending graceful leave, if any; true if there was one. */
  const cancelPendingLeave = (userId: string): boolean => {
    const pending = pendingLeaves.get(userId);
    if (pending === undefined) return false;
    clearTimeout(pending.timer);
    pendingLeaves.delete(userId);
    return true;
  };

  /** The user's stored `voice:state`, if it is about `channelId`. */
  const storedFor = (userId: string, channelId: string): StoredClientState | undefined => {
    const stored = clientStates.get(userId);
    return stored?.payload.channelId === channelId ? stored : undefined;
  };

  const flagsFor = (userId: string, channelId: string): VoiceFlags => {
    const stored = storedFor(userId, channelId)?.payload;
    if (stored === undefined) return DEFAULT_FLAGS;
    return {
      selfMute: stored.selfMute,
      selfDeaf: stored.selfDeaf,
      camera: stored.camera,
      screen: stored.screen,
    };
  };

  /**
   * B.6b rule 1: `flags` with `camera`/`screen` cleared where LiveKit lists no such track, or null if
   * nothing changes. A flag the client sent after `since` is kept (its track may not be published yet).
   * The stored `voice:state` is corrected too, so a later join doesn't bring the stale flag back.
   */
  const withoutStaleMedia = (
    userId: string,
    channelId: string,
    flags: VoiceFlags,
    media: PublishedMedia | undefined,
    since: number,
  ): VoiceFlags | null => {
    if (media === undefined) return null;
    const stored = storedFor(userId, channelId);
    if (stored !== undefined && stored.seq > since) return null;
    const camera = flags.camera && media.camera;
    const screen = flags.screen && media.screen;
    if (camera === flags.camera && screen === flags.screen) return null;
    if (stored !== undefined) {
      stored.payload = {
        ...stored.payload,
        camera: stored.payload.camera && camera,
        screen: stored.payload.screen && screen,
      };
    }
    return { ...flags, camera, screen };
  };

  const add = (
    channelId: string,
    observed: ObservedParticipant,
    flags: VoiceFlags = flagsFor(observed.userId, channelId),
  ): void => {
    const participant: VoiceParticipant = {
      userId: observed.userId,
      joinedAt: observed.joinedAt.toISOString(),
      ...flags,
    };
    let room = rooms.get(channelId);
    if (room === undefined) {
      room = new Map();
      rooms.set(channelId, room);
    }
    seq += 1;
    room.set(observed.userId, { participant, sid: observed.sid, seq });
    userChannel.set(observed.userId, channelId);
    realtime.emitToAll('voice:joined', { channelId, participant });
  };

  /** Removes a membership; `emit: false` for a silent drop. */
  const remove = (channelId: string, userId: string, emit = true): void => {
    const room = rooms.get(channelId);
    const entry = room?.get(userId);
    if (room === undefined || entry === undefined) return;
    cancelPendingLeave(userId);
    room.delete(userId);
    if (room.size === 0) rooms.delete(channelId);
    if (userChannel.get(userId) === channelId) userChannel.delete(userId);
    if (storedFor(userId, channelId) !== undefined) clientStates.delete(userId);
    tombstone(entry.sid);
    if (emit) realtime.emitToAll('voice:left', { channelId, userId });
  };

  /**
   * Takes the connection `evictedSid` of `userId` out of the channel's LiveKit room (fire-and-forget).
   * `removeParticipant` targets an identity, not a sid, so during a fast A→B→A switch a kick meant for the
   * first A connection could drop the re-join. The kick is therefore queued behind the webhooks already
   * received (`exclusive`), and skipped if by then memory holds a different connection of the user in that
   * room. (A re-join whose webhook hasn't arrived yet can still race the request; LiveKit then reports it
   * left, and the client reconnects.)
   */
  const kick = (channelId: string, userId: string, evictedSid: string | undefined): void => {
    void exclusive(() => {
      const current = entryOf(channelId, userId);
      if (current !== undefined && current.sid !== evictedSid) {
        log.debug({ channelId, userId, evictedSid }, 'voice: kick skipped, the user re-joined that room');
        return;
      }
      ignoreNotFound(backend.removeParticipant(voiceRoomName(channelId), userId)).catch((err: unknown) => {
        log.warn({ err: loggableError(err), channelId, userId }, 'voice: removeParticipant failed');
      });
    });
  };

  /** Reconcile: a tombstone counts only if it was written after the pass's `since` mark. */
  const leftSince = (sid: string, since: number): boolean => (leftSids.get(sid) ?? -1) > since;

  return {
    exclusive,

    async processEvent(id, apply) {
      if (id === '') {
        await apply();
        return 'applied';
      }
      for (;;) {
        if (seenEvents.has(id)) return 'duplicate';
        const running = eventsInFlight.get(id);
        if (running === undefined) break;
        // A copy is being handled: wait; then either it succeeded (duplicate) or we handle the event.
        await running.catch(() => undefined);
      }
      const run = apply();
      eventsInFlight.set(id, run);
      try {
        await run;
        seenEvents.set(id, true);
        return 'applied';
      } finally {
        if (eventsInFlight.get(id) === run) eventsInFlight.delete(id);
      }
    },

    participantJoined(channelId, observed) {
      if (leftSids.has(observed.sid)) return;
      const currentChannel = userChannel.get(observed.userId);
      if (currentChannel === channelId) {
        const entry = entryOf(channelId, observed.userId);
        if (entry === undefined || entry.sid === observed.sid) return;
        if (cancelPendingLeave(observed.userId)) {
          // B.9 rule 8: the same user back in the same room within the rejoin grace (a LiveKit
          // reconnect). The membership continues with its flags and join time; nobody saw it end, so
          // nothing is broadcast. (The old sid was tombstoned when it left.)
          seq += 1;
          entry.sid = observed.sid;
          entry.seq = seq;
          return;
        }
        if (observed.joinedAt.getTime() < Date.parse(entry.participant.joinedAt)) {
          // An out-of-order (older) join of a connection LiveKit has since replaced: stale. Tombstone it so
          // its `participant_left` can't remove the live one. No kick: that would target the identity.
          tombstone(observed.sid);
          return;
        }
        // A new connection of the same identity (reconnect or second device): LiveKit drops the older one,
        // whose `participant_left` is then stale. Same membership and flags, new sid and join time.
        tombstone(entry.sid);
        entry.sid = observed.sid;
        entry.seq = seq;
        entry.participant = { ...entry.participant, joinedAt: observed.joinedAt.toISOString() };
        realtime.emitToAll('voice:updated', { channelId, participant: entry.participant });
        return;
      }
      if (currentChannel !== undefined) {
        const other = entryOf(currentChannel, observed.userId);
        if (other !== undefined && Date.parse(other.participant.joinedAt) > observed.joinedAt.getTime()) {
          // An out-of-order (older) join: the user has since moved on. Take them out of this room instead.
          tombstone(observed.sid);
          kick(channelId, observed.userId, observed.sid);
          return;
        }
        // B.6a rule 5: one voice channel at a time; the newest join wins. A connection that already
        // left (its leave waiting out the rejoin grace) needs no kick.
        const alreadyLeft = pendingLeaves.has(observed.userId);
        remove(currentChannel, observed.userId);
        if (!alreadyLeft) kick(currentChannel, observed.userId, other?.sid);
      }
      add(channelId, observed);
    },

    participantLeft(channelId, userId, sid, graceful = false) {
      const entry = entryOf(channelId, userId);
      if (entry?.sid !== sid) {
        tombstone(sid);
        return;
      }
      const pending = pendingLeaves.get(userId);
      if (!graceful || rejoinGraceMs <= 0) {
        remove(channelId, userId);
        return;
      }
      if (pending?.sid === sid) return;
      // The sid is gone for good (a later join webhook for it is stale), but the membership stays listed,
      // flags and all, until the grace ends without a rejoin.
      tombstone(sid);
      const timer = setTimeout(() => {
        void exclusive(() => {
          if (pendingLeaves.get(userId)?.timer !== timer) return;
          pendingLeaves.delete(userId);
          if (entryOf(channelId, userId)?.sid === sid) remove(channelId, userId);
        });
      }, rejoinGraceMs);
      timer.unref();
      pendingLeaves.set(userId, { sid, timer });
    },

    roomFinished(channelId) {
      for (const userId of [...(rooms.get(channelId)?.keys() ?? [])]) remove(channelId, userId);
    },

    setClientState(userId, state) {
      seq += 1;
      clientStates.set(userId, { payload: state, seq });
      const entry = entryOf(state.channelId, userId);
      if (entry === undefined) throw new AppError('VALIDATION', 'You are not in this voice channel');
      entry.participant = {
        ...entry.participant,
        selfMute: state.selfMute,
        selfDeaf: state.selfDeaf,
        camera: state.camera,
        screen: state.screen,
      };
      realtime.emitToAll('voice:updated', { channelId: state.channelId, participant: entry.participant });
      return entry.participant;
    },

    snapshot() {
      const result: Record<string, VoiceParticipant[]> = {};
      for (const [channelId, room] of rooms) {
        result[channelId] = [...room.values()]
          .map((entry) => entry.participant)
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId));
      }
      return result;
    },

    mark: () => seq,

    reconcile(desired, since) {
      // Removals first, so a user who moved between rooms is free to be added to the new one.
      for (const [channelId, room] of [...rooms]) {
        for (const [userId, entry] of [...room]) {
          if (entry.seq > since) continue;
          const wanted = desired.get(channelId)?.get(userId);
          if (wanted === undefined) {
            // A leave waiting out the rejoin grace is settled by its timer (or by the rejoin).
            if (!pendingLeaves.has(userId)) remove(channelId, userId);
            continue;
          }
          if (wanted.sid !== entry.sid && !leftSince(wanted.sid, since)) {
            // LiveKit lists a newer connection: the user is back (its join webhook may still come).
            cancelPendingLeave(userId);
            leftSids.delete(wanted.sid);
            entry.sid = wanted.sid;
          }
          // The listed tracks describe the listed connection only.
          if (wanted.sid !== entry.sid) continue;
          const flags = withoutStaleMedia(userId, channelId, entry.participant, wanted.media, since);
          if (flags !== null) {
            entry.participant = { ...entry.participant, camera: flags.camera, screen: flags.screen };
            realtime.emitToAll('voice:updated', { channelId, participant: entry.participant });
          }
        }
      }
      for (const [channelId, users] of desired) {
        for (const [userId, wanted] of users) {
          // Present already, or somewhere else since the listing: memory is newer than LiveKit's view.
          if (userChannel.has(userId) || leftSince(wanted.sid, since)) continue;
          leftSids.delete(wanted.sid); // LiveKit lists it now: an older tombstone was wrong or superseded.
          const flags = flagsFor(userId, channelId);
          add(channelId, wanted, withoutStaleMedia(userId, channelId, flags, wanted.media, since) ?? flags);
        }
      }
    },

    membershipOf(userId) {
      const channelId = userChannel.get(userId);
      const entry = channelId === undefined ? undefined : entryOf(channelId, userId);
      return channelId === undefined || entry === undefined ? null : { channelId, sid: entry.sid };
    },

    participantIds(channelId) {
      return [...(rooms.get(channelId)?.keys() ?? [])].sort();
    },

    forgetChannel(channelId) {
      for (const userId of [...(rooms.get(channelId)?.keys() ?? [])]) remove(channelId, userId, false);
    },

    clear() {
      for (const userId of [...pendingLeaves.keys()]) cancelPendingLeave(userId);
      eventsInFlight.clear();
      rooms.clear();
      userChannel.clear();
      clientStates.clear();
      seenEvents.clear();
      leftSids.clear();
      seq += 1;
    },

    close() {
      for (const userId of [...pendingLeaves.keys()]) cancelPendingLeave(userId);
    },
  };
}

export interface VoiceEvents {
  /** Forgets every per-user `voice:state` bucket (test reset). */
  clear(): void;
}

/** CONTRACTS B.5 `voice:state` (zod-validated through `onClientEvent`, ack `Ack<null>`). */
export function registerVoiceEvents({
  realtime,
  voice,
  log,
}: {
  realtime: Realtime;
  voice: VoiceState;
  log?: FastifyBaseLogger;
}): VoiceEvents {
  const buckets = new Map<string, { start: number; count: number }>();

  /** Counts one event; 0 when allowed, otherwise the ms until the user's window ends (`retryAfterMs`). */
  const takeToken = (userId: string, now: number): number => {
    const bucket = buckets.get(userId);
    if (bucket === undefined || now - bucket.start >= VOICE_STATE_BUCKET_WINDOW_MS) {
      buckets.set(userId, { start: now, count: 1 });
      return 0;
    }
    bucket.count += 1;
    return bucket.count <= VOICE_STATE_BUCKET_MAX
      ? 0
      : Math.max(1, bucket.start + VOICE_STATE_BUCKET_WINDOW_MS - now);
  };

  realtime.io.on('connection', (socket) => {
    onClientEvent(
      socket,
      'voice:state',
      (payload, s) => {
        const userId = s.data.userId;
        const retryAfterMs = takeToken(userId, Date.now());
        if (retryAfterMs > 0) {
          throw new AppError('RATE_LIMITED', 'Too many voice state updates', { retryAfterMs });
        }
        voice.setClientState(userId, payload);
        return null;
      },
      log,
    );
  });

  return {
    clear() {
      buckets.clear();
    },
  };
}
