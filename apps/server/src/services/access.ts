import { eq } from 'drizzle-orm';
import type { Queryable, ChannelRow, UserRow } from '../db/types.js';
import { channels, dmChannels, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

/** The two members of a DM (`lowId < highId`, as in `dm_channels`) and the one that isn't the caller. */
export interface DmMembers {
  lowId: string;
  highId: string;
  otherUserId: string;
}

/** A channel the caller may read: every text/voice channel, or a DM the caller is a member of. */
export interface ChannelAccess {
  channel: ChannelRow;
  /** Set iff `channel.type === 'dm'`. */
  dm: DmMembers | null;
}

/**
 * CONTRACTS B.4 `access(ch)`. 404 NOT_FOUND for an unknown channel, 403 FORBIDDEN for a DM the caller is
 * not a member of. Every message, DM and delete path goes through this one check.
 */
export async function loadChannelForUser(
  db: Queryable,
  user: Pick<UserRow, 'id'>,
  channelId: string,
): Promise<ChannelAccess> {
  const [row] = await db
    .select({ channel: channels, dm: dmChannels })
    .from(channels)
    .leftJoin(dmChannels, eq(dmChannels.channelId, channels.id))
    .where(eq(channels.id, channelId));
  if (row === undefined) throw new AppError('NOT_FOUND', 'Channel not found');

  const { channel, dm } = row;
  if (channel.type !== 'dm') return { channel, dm: null };
  // A DM channel row without its dm_channels row is never created (same transaction); treat it as missing.
  if (dm === null) throw new AppError('NOT_FOUND', 'Channel not found');
  if (user.id !== dm.userLowId && user.id !== dm.userHighId) {
    throw new AppError('FORBIDDEN', 'You do not have access to this channel');
  }
  return {
    channel,
    dm: {
      lowId: dm.userLowId,
      highId: dm.userHighId,
      otherUserId: user.id === dm.userLowId ? dm.userHighId : dm.userLowId,
    },
  };
}

/**
 * Writing content (send, edit): never in a voice channel (400 VALIDATION), and a DM with a deactivated
 * user is read-only (403 FORBIDDEN).
 */
export async function assertCanPost(db: Queryable, access: ChannelAccess): Promise<void> {
  if (access.channel.type === 'voice') {
    throw new AppError('VALIDATION', 'Cannot post in a voice channel');
  }
  if (access.dm !== null) {
    const [other] = await db
      .select({ deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, access.dm.otherUserId));
    if (other === undefined || other.deactivatedAt !== null) {
      throw new AppError('FORBIDDEN', 'This conversation is read-only');
    }
  }
}
