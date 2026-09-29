import type { ServerEventName, ServerToClientEvents } from '@hearth/shared';
import type { ChannelAccess } from '../services/access.js';
import type { Realtime } from './io.js';

/**
 * Who hears about a channel: `channel.type` plus, for a DM, its two members. `exceptUserId` leaves out
 * every socket of that user (the `typing` sender).
 */
export type ChannelAudience = Pick<ChannelAccess, 'dm'> & {
  channel: Pick<ChannelAccess['channel'], 'type'>;
  exceptUserId?: string;
};

/**
 * CONTRACTS B.5 audience: a text/voice channel → room `all`; a DM → `user:<low>` and `user:<high>` only.
 * The single emit path for channel-scoped events. Call only after the DB transaction has committed.
 */
export function emitToChannel<E extends ServerEventName>(
  realtime: Realtime,
  audience: ChannelAudience,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  if (audience.channel.type === 'dm') {
    // Fail closed: a DM without members goes to nobody, never to `all`.
    if (audience.dm === null) return;
    const members = [audience.dm.lowId, audience.dm.highId].filter((id) => id !== audience.exceptUserId);
    realtime.emitToUsers(members, event, ...args);
    return;
  }
  if (audience.exceptUserId === undefined) realtime.emitToAll(event, ...args);
  else realtime.emitToAllExcept(audience.exceptUserId, event, ...args);
}
