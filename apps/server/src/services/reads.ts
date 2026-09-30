import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { ReadState } from '@hearth/shared';
import { channels, dmChannels, messageMentions, messages, readStates, users } from '../db/schema.js';
import type { MessageRow, Queryable } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import type { ChannelAccess } from './access.js';
import { rethrowIfGone } from './gone.js';

/**
 * Moves `(userId, channelId)` forward to `messageId`, never back (`GREATEST`). `messageId` is a MessageId
 * string, bound as text and cast in SQL (it may exceed `Number.MAX_SAFE_INTEGER`).
 */
export async function advanceReadState(
  db: Queryable,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await db
    .insert(readStates)
    .values({ userId, channelId, lastReadMessageId: sql`${messageId}::bigint` })
    .onConflictDoUpdate({
      target: [readStates.userId, readStates.channelId],
      set: {
        lastReadMessageId: sql`greatest(${readStates.lastReadMessageId}, excluded.last_read_message_id)`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * `ReadState` rows for `userId` (B.5a rule 3), in one query: every text channel and every DM the user is
 * a member of (voice channels have no messages), optionally narrowed to one channel.
 * - `unread`: a message by someone else exists after `lastReadMessageId` (index `(channel_id, id)`).
 * - `mentionCount`: the user's mention rows after it (index `(user_id, channel_id, message_id)`).
 */
export async function listReadStates(
  db: Queryable,
  userId: string,
  onlyChannelId?: string,
): Promise<ReadState[]> {
  const me = sql`${userId}::uuid`;
  const lastRead = sql`coalesce(${readStates.lastReadMessageId}, 0)`;
  const accessible: SQL | undefined = or(
    eq(channels.type, 'text'),
    and(eq(channels.type, 'dm'), or(eq(dmChannels.userLowId, userId), eq(dmChannels.userHighId, userId))),
  );
  return db
    .select({
      channelId: channels.id,
      lastReadMessageId: sql<string>`${lastRead}::text`,
      unread: sql<boolean>`exists (
        select 1 from ${messages}
        where ${messages.channelId} = ${channels.id} and ${messages.id} > ${lastRead}
          and ${messages.authorId} <> ${me})`,
      mentionCount: sql<number>`(
        select count(*)::int from ${messageMentions}
        where ${messageMentions.userId} = ${me} and ${messageMentions.channelId} = ${channels.id}
          and ${messageMentions.messageId} > ${lastRead})`,
    })
    .from(channels)
    .leftJoin(dmChannels, eq(dmChannels.channelId, channels.id))
    .leftJoin(readStates, and(eq(readStates.channelId, channels.id), eq(readStates.userId, userId)))
    .where(onlyChannelId === undefined ? accessible : and(accessible, eq(channels.id, onlyChannelId)))
    .orderBy(asc(channels.createdAt), asc(channels.id));
}

/** The `ReadState` of one accessible channel (the caller has already checked access). */
export async function getReadState(db: Queryable, userId: string, channelId: string): Promise<ReadState> {
  const [state] = await listReadStates(db, userId, channelId);
  if (state === undefined) throw new AppError('NOT_FOUND', 'Channel not found');
  return state;
}

/**
 * CONTRACTS B.4 row 26: `messageId` must be a message of `channelId` (400 VALIDATION otherwise). Forward-only;
 * returns the resulting state (unchanged when `messageId` is older than the stored one).
 */
export async function markRead(
  db: Queryable,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<ReadState> {
  const [message] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(sql`${messages.id} = ${messageId}::bigint`, eq(messages.channelId, channelId)));
  if (message === undefined) throw new AppError('VALIDATION', 'Message is not in this channel');
  await advanceReadState(db, userId, channelId, messageId).catch(rethrowIfGone);
  return getReadState(db, userId, channelId);
}

/**
 * The `ReadState` in `channelId` of each of `userIds`, keyed by user id, in one query (same rules as
 * `listReadStates`; the caller knows they can all access the channel). Used to send the users whose state a
 * message delete or edit changed a fresh `readstate:updated` (B.9 rule 6).
 */
export async function readStatesOfUsers(
  db: Queryable,
  channelId: string,
  userIds: readonly string[],
): Promise<Map<string, ReadState>> {
  const result = new Map<string, ReadState>();
  if (userIds.length === 0) return result;
  const channel = sql`${channelId}::uuid`;
  const lastRead = sql`coalesce(${readStates.lastReadMessageId}, 0)`;
  const rows = await db
    .select({
      userId: users.id,
      lastReadMessageId: sql<string>`${lastRead}::text`,
      unread: sql<boolean>`exists (
        select 1 from ${messages}
        where ${messages.channelId} = ${channel} and ${messages.id} > ${lastRead}
          and ${messages.authorId} <> ${users.id})`,
      mentionCount: sql<number>`(
        select count(*)::int from ${messageMentions}
        where ${messageMentions.userId} = ${users.id} and ${messageMentions.channelId} = ${channel}
          and ${messageMentions.messageId} > ${lastRead})`,
    })
    .from(users)
    .leftJoin(readStates, and(eq(readStates.userId, users.id), eq(readStates.channelId, channelId)))
    .where(inArray(users.id, [...userIds]));
  for (const { userId, ...state } of rows) result.set(userId, { channelId, ...state });
  return result;
}

/**
 * Who, among `candidateIds` (default: everyone who can read the channel), currently counts message
 * `message` as unread: active readers of the channel other than its author whose read position is before
 * it. Only their unread flag or mention count can change when it is deleted or its mentions change.
 */
export async function usersCountingMessage(
  db: Queryable,
  access: ChannelAccess,
  message: Pick<MessageRow, 'id' | 'channelId' | 'authorId'>,
  candidateIds?: readonly string[],
): Promise<string[]> {
  if (candidateIds?.length === 0) return [];
  const readers: SQL | undefined =
    access.dm === null ? undefined : inArray(users.id, [access.dm.lowId, access.dm.highId]);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(readStates, and(eq(readStates.userId, users.id), eq(readStates.channelId, message.channelId)))
    .where(
      and(
        isNull(users.deactivatedAt),
        ne(users.id, message.authorId),
        sql`coalesce(${readStates.lastReadMessageId}, 0) < ${message.id}`,
        readers,
        candidateIds === undefined ? undefined : inArray(users.id, [...candidateIds]),
      ),
    );
  return rows.map((row) => row.id);
}

/** A user's new read state, to be sent as `readstate:updated` to `user:<userId>` after the commit. */
export interface ReadStateChange {
  userId: string;
  readState: ReadState;
}

/**
 * The states in `after` that differ from `before` (B.9 rule 6: only a user whose unread flag or mention
 * count actually changed gets an event).
 */
export function changedReadStates(
  before: ReadonlyMap<string, ReadState>,
  after: ReadonlyMap<string, ReadState>,
): ReadStateChange[] {
  const changes: ReadStateChange[] = [];
  for (const [userId, readState] of after) {
    const old = before.get(userId);
    if (
      old === undefined ||
      old.lastReadMessageId !== readState.lastReadMessageId ||
      old.unread !== readState.unread ||
      old.mentionCount !== readState.mentionCount
    ) {
      changes.push({ userId, readState });
    }
  }
  return changes;
}
