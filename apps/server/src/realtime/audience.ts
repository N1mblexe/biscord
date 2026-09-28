import type { ServerEventName, ServerToClientEvents } from '@hearth/shared';
import type { ChannelAccess } from '../services/access.js';
import type { Realtime } from './io.js';

/** Who hears about a channel: `channel.type` plus, for a DM, its two members. */
export type ChannelAudience = Pick<ChannelAccess, 'dm'> & { channel: Pick<ChannelAccess['channel'], 'type'> };

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
    realtime.emitToUsers([audience.dm.lowId, audience.dm.highId], event, ...args);
    return;
  }
  realtime.emitToAll(event, ...args);
}
