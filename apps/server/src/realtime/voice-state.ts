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
  /** Marks a webhook event id as seen; false if it was already (a duplicate). Empty ids always pass. */
  claimEvent(id: string): boolean;
  /** Forgets a claimed id whose handling failed, so LiveKit's retry is processed. */
  releaseEvent(id: string): void;
  /**
   * `participant_joined`. A stale join (its sid already left) is ignored. If the user is in another channel,
   * the most recent join wins: the other room gets a `removeParticipant` (B.6a rule 5).
   */
  participantJoined(channelId: string, participant: ObservedParticipant): void;
  /** `participant_left` / `participant_connection_aborted`; ignored unless `sid` is the current connection. */
  participantLeft(channelId: string, userId: string, sid: string): void;
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
  /** Drops a channel's participants without emitting (the channel was deleted; `channel:deleted` follows). */
  forgetChannel(channelId: string): void;
  /** Forgets everything, including the webhook id cache, without emitting (test reset). */
  clear(): void;
}

export interface VoiceStateDeps {
  realtime: Realtime;
  backend: VoiceBackend;
  log: FastifyBaseLogger;
}

export function createVoiceState({ realtime, backend, log }: VoiceStateDeps): VoiceState {
  /** channel id → user id → entry. */
  const rooms = new Map<string, Map<string, Entry>>();
  /** user id → the channel id they are in (the one-channel rule keeps this a function). */
  const userChannel = new Map<string, string>();
  /** user id → the last `voice:state` they sent. */
  const clientStates = new Map<string, StoredClientState>();
  const seenEvents = new BoundedMap<true>(WEBHOOK_ID_CACHE_SIZE);
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

    claimEvent(id) {
      if (id === '') return true;
      if (seenEvents.has(id)) return false;
      seenEvents.set(id, true);
      return true;
    },

    releaseEvent(id) {
      seenEvents.delete(id);
    },

    participantJoined(channelId, observed) {
      if (leftSids.has(observed.sid)) return;
      const currentChannel = userChannel.get(observed.userId);
      if (currentChannel === channelId) {
        const entry = entryOf(channelId, observed.userId);
        if (entry === undefined || entry.sid === observed.sid) return;
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
        // B.6a rule 5: one voice channel at a time; the newest join wins.
        remove(currentChannel, observed.userId);
        kick(currentChannel, observed.userId, other?.sid);
      }
      add(channelId, observed);
    },

    participantLeft(channelId, userId, sid) {
      const entry = entryOf(channelId, userId);
      if (entry !== undefined && entry.sid === sid) remove(channelId, userId);
      else tombstone(sid);
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
            remove(channelId, userId);
            continue;
          }
          if (wanted.sid !== entry.sid && !leftSince(wanted.sid, since)) {
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

    forgetChannel(channelId) {
      for (const userId of [...(rooms.get(channelId)?.keys() ?? [])]) remove(channelId, userId, false);
    },

    clear() {
      rooms.clear();
      userChannel.clear();
      clientStates.clear();
      seenEvents.clear();
      leftSids.clear();
      seq += 1;
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

  const takeToken = (userId: string, now: number): boolean => {
    const bucket = buckets.get(userId);
    if (bucket === undefined || now - bucket.start >= VOICE_STATE_BUCKET_WINDOW_MS) {
      buckets.set(userId, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= VOICE_STATE_BUCKET_MAX;
  };

  realtime.io.on('connection', (socket) => {
    onClientEvent(
      socket,
      'voice:state',
      (payload, s) => {
        const userId = s.data.userId;
        if (!takeToken(userId, Date.now())) {
          throw new AppError('RATE_LIMITED', 'Too many voice state updates');
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
