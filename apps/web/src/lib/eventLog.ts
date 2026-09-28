import type { HearthSocket } from '../socket/socket';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The channel a server→client payload is about: `channelId`, `message.channelId` or `channel.id`. */
export function eventChannelId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.channelId === 'string') return payload.channelId;
  const { message, channel } = payload;
  if (isRecord(message) && typeof message.channelId === 'string') return message.channelId;
  if (isRecord(channel) && typeof channel.id === 'string') return channel.id;
  return null;
}

/**
 * E2E builds only (`VITE_E2E=true`): records `{ event, channelId }` for every server→client event in
 * `window.__hearthEvents` (the DM-privacy test asserts no event for a DM reached a third user).
 * In every other build `import.meta.env.VITE_E2E` is replaced statically, so this is dead code.
 */
export function installEventLog(socket: HearthSocket): () => void {
  if (import.meta.env.VITE_E2E !== 'true') return () => undefined;
  const log = (window.__hearthEvents ??= []);
  const listener = (event: string, payload?: unknown) => {
    log.push({ event, channelId: eventChannelId(payload) });
  };
  socket.onAny(listener);
  return () => {
    socket.offAny(listener);
  };
}
