import { and, asc, count, eq, inArray, max, ne, sql, type SQL } from 'drizzle-orm';
import { LIMITS, voiceRoomName, type ChannelType } from '@hearth/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelRow, Queryable } from '../db/types.js';
import { AppError, loggableError } from '../lib/errors.js';
import { ignoreNotFound, type VoiceBackend } from '../livekit/client.js';
import { storageKeysOfChannel } from './attachments.js';
import { assertStillAdmin, lockStillAdmin } from './users.js';

/**
 * Key for `pg_advisory_xact_lock`: serializes channel create / reorder / delete, so the 50-channel cap and
 * the reorder set check see a stable set of channels. ASCII "HCHN". Always taken after the users lock
 * (`lockStillAdmin`), never before it.
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

/**
 * Ids of this database's voice channels: all of them, or those among `ids` (non-UUID strings must not be
 * passed). The shared LiveKit server also hosts rooms of other databases (B.6a rule 3); this is the filter.
 */
export async function listVoiceChannelIds(db: Queryable, ids?: readonly string[]): Promise<string[]> {
  if (ids?.length === 0) return [];
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      ids === undefined
        ? eq(channels.type, 'voice')
        : and(eq(channels.type, 'voice'), inArray(channels.id, [...ids])),
    );
  return rows.map((row) => row.id);
}

/**
 * Every mutation below takes `actorId`, the requesting admin, who must still be one inside the transaction
 * (B.7b rule 7: `FORBIDDEN` after a concurrent demotion or deactivation).
 */

/** Appends at `max(position) + 1`; 409 CHANNEL_LIMIT once there are 50 text/voice channels. */
export function createChannel(
  db: Db,
  actorId: string,
  input: { type: ChannelType; name: string },
): Promise<ChannelRow> {
  return db.transaction(async (tx) => {
    await lockStillAdmin(tx, actorId);
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
export function renameChannel(db: Db, actorId: string, id: string, name: string): Promise<ChannelRow> {
  return db.transaction(async (tx) => {
    await lockStillAdmin(tx, actorId);
    const [row] = await tx
      .update(channels)
      .set({ name })
      .where(and(eq(channels.id, id), notDm()))
      .returning();
    if (row === undefined) throw notFound();
    return row;
  });
}

/**
 * `ids` must be exactly the set of text/voice channels (400 VALIDATION otherwise). Rewrites positions to
 * 0..n-1 in that order, in one transaction, and returns the channels in their new order.
 */
export function reorderChannels(db: Db, actorId: string, ids: readonly string[]): Promise<ChannelRow[]> {
  const wanted = ids.map((id) => id.toLowerCase());
  return db.transaction(async (tx) => {
    await lockStillAdmin(tx, actorId);
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
 * CONTRACTS B.7 "delete channel": a voice channel's LiveKit room is deleted first (503 LIVEKIT_UNAVAILABLE and
 * no DB change if that fails). The DB delete cascades to messages, reactions, mentions, read states
 * and attachment rows. Returns the deleted row and the storage keys of its attachments, which the caller
 * unlinks after the commit; 404 NOT_FOUND for an unknown id or a DM. The caller deletes a voice room once
 * more after the commit (B.7b rule 7).
 */
export async function deleteChannel(
  db: Db,
  actorId: string,
  id: string,
  { voiceBackend, log }: { voiceBackend: VoiceBackend; log: FastifyBaseLogger },
): Promise<{ channel: ChannelRow; storageKeys: string[] }> {
  const channel = await findChannel(db, id);
  if (channel === null) throw notFound();

  if (channel.type === 'voice') {
    // Not a guarantee (that is the check in the transaction below), but a demoted admin shouldn't get to
    // close a room just because the channel delete itself will be refused.
    await assertStillAdmin(db, actorId);
    // B.7 step 1: close the LiveKit room first (a 404 counts as success). Any other failure keeps the channel.
    try {
      await ignoreNotFound(voiceBackend.deleteRoom(voiceRoomName(channel.id)));
    } catch (err) {
      log.warn({ err: loggableError(err), channelId: channel.id }, 'voice channel delete: deleteRoom failed');
      throw new AppError('LIVEKIT_UNAVAILABLE', 'Voice server unavailable, the channel was not deleted');
    }
  }

  return db.transaction(async (tx) => {
    await lockStillAdmin(tx, actorId);
    await lockChannels(tx);
    // Lock the channel row first: a concurrent message insert needs a key-share lock on it, so no new
    // message (and no newly claimed attachment) can appear between collecting the keys and the delete.
    const [locked] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, id), notDm()))
      .for('update');
    if (locked === undefined) throw notFound();
    const storageKeys = await storageKeysOfChannel(tx, id);
    const [deleted] = await tx
      .delete(channels)
      .where(and(eq(channels.id, id), notDm()))
      .returning();
    if (deleted === undefined) throw notFound();
    return { channel: deleted, storageKeys };
  });
}
