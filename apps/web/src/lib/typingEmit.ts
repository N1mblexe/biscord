import { LIMITS } from '@hearth/shared';
import type { HearthSocket } from '../socket/socket';

/** When we last sent `typing:start` per channel. */
const lastSent = new Map<string, number>();

/**
 * Sends `typing:start` for `channelId`, at most once per `LIMITS.typingThrottleMs` per channel, and
 * only while connected (a buffered event would arrive late). Ack errors are ignored: the indicator
 * is best-effort. Returns whether an event was sent.
 */
export function emitTyping(socket: HearthSocket, channelId: string, now = Date.now()): boolean {
  if (!socket.connected) return false;
  const last = lastSent.get(channelId);
  if (last !== undefined && now - last < LIMITS.typingThrottleMs) return false;
  lastSent.set(channelId, now);
  socket.emit('typing:start', { channelId }, () => undefined);
  return true;
}

/** After a send: the next keystroke announces typing again straight away. */
export function resetTypingThrottle(channelId: string): void {
  lastSent.delete(channelId);
}
