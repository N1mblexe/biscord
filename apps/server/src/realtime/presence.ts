import type { PresencePayload } from '@hearth/shared';

/**
 * CONTRACTS B.5a rule 6. In memory only: a user is online while they have at least one connected socket,
 * and stays online for `graceMs` after the last one closes (a reconnect within it cancels the offline).
 * `emit` is called only on an actual change.
 */
export interface Presence {
  /** A socket of `userId` connected. Emits `online: true` only if the user was offline. */
  connect(userId: string, socketId: string): void;
  /** A socket closed. The last one starts the grace timer; unknown sockets are ignored. */
  disconnect(userId: string, socketId: string): void;
  /** Online users (connected, or within the grace period), sorted. */
  onlineUserIds(): string[];
  /** Forgets every socket and cancels every pending offline, without emitting (test reset, shutdown). */
  clear(): void;
}

export interface PresenceOptions {
  graceMs: number;
  emit: (payload: PresencePayload) => void;
}

export function createPresence({ graceMs, emit }: PresenceOptions): Presence {
  /** Users with at least one live socket. A user is never here with an empty set. */
  const sockets = new Map<string, Set<string>>();
  /** Users with no socket left whose `online: false` is still pending. */
  const pendingOffline = new Map<string, NodeJS.Timeout>();

  return {
    connect(userId, socketId) {
      const wasOnline = sockets.has(userId) || pendingOffline.has(userId);
      const timer = pendingOffline.get(userId);
      if (timer !== undefined) {
        clearTimeout(timer);
        pendingOffline.delete(userId);
      }
      const set = sockets.get(userId);
      if (set === undefined) sockets.set(userId, new Set([socketId]));
      else set.add(socketId);
      if (!wasOnline) emit({ userId, online: true });
    },

    disconnect(userId, socketId) {
      const set = sockets.get(userId);
      if (set?.delete(socketId) !== true || set.size > 0) return;
      sockets.delete(userId);
      const timer = setTimeout(() => {
        pendingOffline.delete(userId);
        emit({ userId, online: false });
      }, graceMs);
      // Never keep the process alive just to announce an offline.
      timer.unref();
      pendingOffline.set(userId, timer);
    },

    onlineUserIds() {
      return [...new Set([...sockets.keys(), ...pendingOffline.keys()])].sort();
    },

    clear() {
      for (const timer of pendingOffline.values()) clearTimeout(timer);
      pendingOffline.clear();
      sockets.clear();
    },
  };
}
