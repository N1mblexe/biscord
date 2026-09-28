import { and, asc, count, eq, max, ne, sql, type SQL } from 'drizzle-orm';
import { LIMITS, type ChannelType } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelRow, Queryable } from '../db/types.js';
import { AppError } from '../lib/errors.js';

/**
 * Key for `pg_advisory_xact_lock`: serializes channel create / reorder / delete, so the 50-channel cap and
 * the reorder set check see a stable set of channels. ASCII "HCHN".
 */
export const CHANNELS_LOCK_KEY = 0x4843484e;

const notDm = (): SQL => ne(channels.type, 'dm');

async function lockChannels(tx: Queryable): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CHANNELS_LOCK_KEY})`);
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'Channel not found');

/** Every text and voice channel in sidebar order (one `position` order across both types). */
export function listChannels(db: Queryable): Promise<ChannelRow[]> {
  return db
    .select()
    .from(channels)
    .where(notDm())
    .orderBy(asc(channels.position), asc(channels.createdAt), asc(channels.id));
}

/** A text or voice channel by id (DMs are not managed here), or `null`. */
export async function findChannel(db: Queryable, id: string): Promise<ChannelRow | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), notDm()));
  return row ?? null;
}

/** Appends at `max(position) + 1`; 409 CHANNEL_LIMIT once there are 50 text/voice channels. */
export function createChannel(db: Db, input: { type: ChannelType; name: string }): Promise<ChannelRow> {
  return db.transaction(async (tx) => {
    await lockChannels(tx);
    const [stats] = await tx
      .select({ n: count(), maxPosition: max(channels.position) })
      .from(channels)
      .where(notDm());
    if ((stats?.n ?? 0) >= LIMITS.maxChannels) {
      throw new AppError('CHANNEL_LIMIT', `A server can have at most ${LIMITS.maxChannels} channels`);
    }
    const [row] = await tx
      .insert(channels)
      .values({ type: input.type, name: input.name, position: (stats?.maxPosition ?? -1) + 1 })
      .returning();
    if (row === undefined) throw new Error('channel insert returned no row');
    return row;
  });
}

/** 404 NOT_FOUND for an unknown id or a DM. */
export async function renameChannel(db: Queryable, id: string, name: string): Promise<ChannelRow> {
  const [row] = await db
    .update(channels)
    .set({ name })
    .where(and(eq(channels.id, id), notDm()))
    .returning();
  if (row === undefined) throw notFound();
  return row;
}

/**
 * `ids` must be exactly the set of text/voice channels (400 VALIDATION otherwise). Rewrites positions to
 * 0..n-1 in that order, in one transaction, and returns the channels in their new order.
 */
export function reorderChannels(db: Db, ids: readonly string[]): Promise<ChannelRow[]> {
  const wanted = ids.map((id) => id.toLowerCase());
  return db.transaction(async (tx) => {
    await lockChannels(tx);
    const existing = await tx.select({ id: channels.id }).from(channels).where(notDm());
    const existingIds = new Set(existing.map((row) => row.id));
    const sameSet =
      wanted.length === existingIds.size &&
      new Set(wanted).size === wanted.length &&
      wanted.every((id) => existingIds.has(id));
    if (!sameSet) {
      throw new AppError('VALIDATION', 'ids must list every channel exactly once');
    }
    if (wanted.length > 0) {
      const cases: SQL[] = wanted.map((id, index) => sql`when ${id}::uuid then ${index}::integer`);
      await tx
        .update(channels)
        .set({ position: sql`case ${channels.id} ${sql.join(cases, sql` `)} end` })
        .where(notDm());
    }
    return listChannels(tx);
  });
}

/**
 * CONTRACTS B.7 "delete channel": the DB delete cascades to messages, reactions, mentions, read states
 * and attachment rows. Returns the deleted row; 404 NOT_FOUND for an unknown id or a DM.
 */
export async function deleteChannel(db: Db, id: string): Promise<ChannelRow> {
  const channel = await findChannel(db, id);
  if (channel === null) throw notFound();

  if (channel.type === 'voice') {
    // TODO(phase 6): LiveKit `deleteRoom(voiceRoomName(id))` goes HERE, before the DB delete (B.7 step 1;
    // a 404 from LiveKit counts as success, any other failure → 503 LIVEKIT_UNAVAILABLE and no DB change).
  }

  return db.transaction(async (tx) => {
    await lockChannels(tx);
    // TODO(phase 5): collect the attachment storage keys of this channel's messages here, and unlink them
    // after the commit (B.7 "delete text channel").
    const [deleted] = await tx
      .delete(channels)
      .where(and(eq(channels.id, id), notDm()))
      .returning();
    if (deleted === undefined) throw notFound();
    return deleted;
  });
}
