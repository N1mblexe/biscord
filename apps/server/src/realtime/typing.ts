import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { assertCanPost, loadChannelForUser } from '../services/access.js';
import { emitToChannel } from './audience.js';
import { onClientEvent, type HearthSocket, type Realtime } from './io.js';

/** Server-side `typing` broadcast throttle per user+channel (B.5a rule 5). Clients send at most 1 per 3 s. */
export const TYPING_BROADCAST_THROTTLE_MS = 2_000;

/**
 * Per-user flood guard, checked before any DB access: at most `TYPING_USER_BUCKET_MAX` `typing:start`
 * events per `TYPING_USER_BUCKET_WINDOW_MS` per user, across all channels (and all of the user's
 * sockets). A real client sends about one per 3 s per channel, so only spam hits it; the excess is
 * acked ok and dropped like a throttled event.
 */
export const TYPING_USER_BUCKET_MAX = 10;
export const TYPING_USER_BUCKET_WINDOW_MS = 5_000;

/** Above this many throttle entries, stale ones are swept on the next broadcast. */
const SWEEP_THRESHOLD = 500;

export interface Typing {
  /** Forgets every throttle entry and per-user bucket (test reset). */
  clear(): void;
}

export interface TypingDeps {
  db: Db;
  realtime: Realtime;
  log?: FastifyBaseLogger;
  /** Defaults to `TYPING_BROADCAST_THROTTLE_MS`; tests shorten it. */
  throttleMs?: number;
}

/**
 * CONTRACTS B.5 `typing:start` → `typing` to the channel audience except every socket of the sender.
 * Access as for posting: unknown channel → NOT_FOUND, not a DM member or a read-only DM → FORBIDDEN,
 * voice → VALIDATION. At most one broadcast per user+channel per `throttleMs`; extras are acked ok and dropped.
 * Events over the per-user bucket are acked ok and dropped before any access check.
 */
export function registerTyping({
  db,
  realtime,
  log,
  throttleMs = TYPING_BROADCAST_THROTTLE_MS,
}: TypingDeps): Typing {
  /** `userId:channelId` → time of the last broadcast. Only set after a successful access check. */
  const lastBroadcast = new Map<string, number>();
  /** `userId` → the current fixed window of `typing:start` events (one entry per user: bounded). */
  const buckets = new Map<string, { start: number; count: number }>();

  /** Counts one event for `userId`; false when it is over the per-user limit. */
  const takeToken = (userId: string, now: number): boolean => {
    const bucket = buckets.get(userId);
    if (bucket === undefined || now - bucket.start >= TYPING_USER_BUCKET_WINDOW_MS) {
      buckets.set(userId, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= TYPING_USER_BUCKET_MAX;
  };

  const throttled = (key: string, now: number): boolean => {
    const last = lastBroadcast.get(key);
    return last !== undefined && now - last < throttleMs;
  };

  const sweep = (now: number): void => {
    if (lastBroadcast.size <= SWEEP_THRESHOLD) return;
    for (const [key, at] of lastBroadcast) {
      if (now - at >= throttleMs) lastBroadcast.delete(key);
    }
  };

  const handle = async (channelId: string, socket: HearthSocket): Promise<null> => {
    const userId = socket.data.userId;
    const key = `${userId}:${channelId.toLowerCase()}`;
    // A key exists only after this user passed the access check here, so repeats skip the DB entirely.
    if (throttled(key, Date.now())) return null;
    // Anything else (other channels, forbidden or unknown ids) is capped per user before the DB.
    if (!takeToken(userId, Date.now())) return null;

    const access = await loadChannelForUser(db, { id: userId }, channelId);
    await assertCanPost(db, access);

    // Re-check after the awaits: two events in flight at once must still broadcast only once.
    const now = Date.now();
    if (throttled(key, now)) return null;
    lastBroadcast.set(key, now);
    sweep(now);

    emitToChannel(realtime, { ...access, exceptUserId: userId }, 'typing', {
      channelId: access.channel.id,
      userId,
    });
    return null;
  };

  realtime.io.on('connection', (socket) => {
    onClientEvent(socket, 'typing:start', ({ channelId }, s) => handle(channelId, s), log);
  });

  return {
    clear() {
      lastBroadcast.clear();
      buckets.clear();
    },
  };
}
