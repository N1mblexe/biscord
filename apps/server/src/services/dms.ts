import { and, asc, eq, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels, dmChannels } from '../db/schema.js';
import type { Queryable, UserRow } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { findUserById } from './users.js';

export interface DmRef {
  channelId: string;
  lowId: string;
  highId: string;
}

export interface GetOrCreateDmResult extends DmRef {
  created: boolean;
}

/**
 * The `(low, high)` order of `dm_channels`. Postgres compares uuids byte by byte, which matches comparing
 * their canonical lower-case strings.
 */
export function orderPair(a: string, b: string): { lowId: string; highId: string } {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? { lowId: x, highId: y } : { lowId: y, highId: x };
}

async function findDmByPair(db: Queryable, lowId: string, highId: string): Promise<DmRef | null> {
  const [row] = await db
    .select()
    .from(dmChannels)
    .where(and(eq(dmChannels.userLowId, lowId), eq(dmChannels.userHighId, highId)));
  return row === undefined
    ? null
    : { channelId: row.channelId, lowId: row.userLowId, highId: row.userHighId };
}

/**
 * CONTRACTS B.4 row 19. 403 FORBIDDEN for yourself or a deactivated user, 404 NOT_FOUND for an unknown one.
 * Concurrent creates of the same pair race on `dm_channels_pair_uq`: the loser's insert does nothing, it
 * drops its own channel row and returns the winner's DM (`created: false`).
 */
export async function getOrCreateDm(
  db: Db,
  me: Pick<UserRow, 'id'>,
  otherUserId: string,
): Promise<GetOrCreateDmResult> {
  if (otherUserId.toLowerCase() === me.id) throw new AppError('FORBIDDEN', 'You cannot message yourself');
  const other = await findUserById(db, otherUserId);
  if (other === null) throw new AppError('NOT_FOUND', 'User not found');
  if (other.deactivatedAt !== null) throw new AppError('FORBIDDEN', 'This user is deactivated');

  const { lowId, highId } = orderPair(me.id, other.id);
  const existing = await findDmByPair(db, lowId, highId);
  if (existing !== null) return { ...existing, created: false };

  return db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({ type: 'dm', name: null })
      .returning({ id: channels.id });
    if (channel === undefined) throw new Error('channel insert returned no row');
    const [inserted] = await tx
      .insert(dmChannels)
      .values({ channelId: channel.id, userLowId: lowId, userHighId: highId })
      .onConflictDoNothing({ target: [dmChannels.userLowId, dmChannels.userHighId] })
      .returning({ channelId: dmChannels.channelId });
    if (inserted !== undefined) return { channelId: inserted.channelId, lowId, highId, created: true };

    // Lost the race: another transaction committed this pair first (READ COMMITTED sees it now).
    await tx.delete(channels).where(eq(channels.id, channel.id));
    const winner = await findDmByPair(tx, lowId, highId);
    if (winner === null) throw new Error('dm pair conflict but no existing row');
    return { ...winner, created: false };
  });
}

/** The caller's DMs, oldest first, each with the other member's id. */
export async function listDmsForUser(
  db: Queryable,
  userId: string,
): Promise<{ channelId: string; otherUserId: string }[]> {
  const rows = await db
    .select({ channelId: dmChannels.channelId, lowId: dmChannels.userLowId, highId: dmChannels.userHighId })
    .from(dmChannels)
    .innerJoin(channels, eq(channels.id, dmChannels.channelId))
    .where(or(eq(dmChannels.userLowId, userId), eq(dmChannels.userHighId, userId)))
    .orderBy(asc(channels.createdAt), asc(channels.id));
  return rows.map((row) => ({
    channelId: row.channelId,
    otherUserId: row.lowId === userId ? row.highId : row.lowId,
  }));
}
