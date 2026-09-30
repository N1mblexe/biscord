import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { LIMITS, type Reaction } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { messageReactions, messages } from '../db/schema.js';
import type { MessageRow, Queryable, UserRow } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { assertCanPost, loadChannelForUser, type ChannelAccess } from './access.js';
import { rethrowIfGone } from './gone.js';

export interface ReactionChange {
  message: MessageRow;
  access: ChannelAccess;
  /** False when the PUT/DELETE was a no-op (no event, B.5a rule 4). */
  changed: boolean;
}

/**
 * Loads the message (optionally `for update`), then checks `access` and that the conversation is writable
 * (a read-only DM → FORBIDDEN).
 */
async function loadReactableMessage(
  db: Queryable,
  user: Pick<UserRow, 'id'>,
  messageId: string,
  { lock }: { lock: boolean },
): Promise<{ message: MessageRow; access: ChannelAccess }> {
  const query = db
    .select()
    .from(messages)
    .where(sql`${messages.id} = ${messageId}::bigint`);
  const [message] = lock ? await query.for('update') : await query;
  if (message === undefined) throw new AppError('NOT_FOUND', 'Message not found');
  const access = await loadChannelForUser(db, user, message.channelId);
  await assertCanPost(db, access);
  return { message, access };
}

/**
 * CONTRACTS B.4 row 24. Idempotent. A new distinct emoji beyond `LIMITS.distinctReactionsPerMessage` →
 * 409 CONFLICT; the cap is checked under a row lock on the message, so concurrent PUTs can't overshoot it.
 * The lock also makes a concurrent message/channel delete a 404 (it waits for the delete, then finds no
 * row); the FK mapping is a backstop (B.9 rule 6).
 */
export async function addReaction(
  db: Db,
  user: Pick<UserRow, 'id'>,
  messageId: string,
  emoji: string,
): Promise<ReactionChange> {
  const change = db.transaction(async (tx) => {
    const { message, access } = await loadReactableMessage(tx, user, messageId, { lock: true });

    const present = await tx
      .selectDistinct({ emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, message.id));
    const known = present.some((row) => row.emoji === emoji);
    if (!known && present.length >= LIMITS.distinctReactionsPerMessage) {
      throw new AppError(
        'CONFLICT',
        `A message can have at most ${LIMITS.distinctReactionsPerMessage} different reactions`,
      );
    }

    const inserted = await tx
      .insert(messageReactions)
      .values({ messageId: message.id, userId: user.id, emoji })
      .onConflictDoNothing()
      .returning({ messageId: messageReactions.messageId });
    return { message, access, changed: inserted.length > 0 };
  });
  return change.catch(rethrowIfGone);
}

/** CONTRACTS B.4 row 25. Idempotent: removing a missing reaction is a no-op. */
export async function removeReaction(
  db: Db,
  user: Pick<UserRow, 'id'>,
  messageId: string,
  emoji: string,
): Promise<ReactionChange> {
  const { message, access } = await loadReactableMessage(db, user, messageId, { lock: false });
  const deleted = await db
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, message.id),
        eq(messageReactions.userId, user.id),
        eq(messageReactions.emoji, emoji),
      ),
    )
    .returning({ messageId: messageReactions.messageId });
  return { message, access, changed: deleted.length > 0 };
}

/**
 * `Reaction[]` for a set of messages, in one query (B.5a rule 4): per message, emojis ordered by their first
 * reaction time, and each emoji's `userIds` by reaction time. Messages without reactions are absent.
 */
export async function reactionsByMessage(
  db: Queryable,
  messageIds: readonly number[],
): Promise<Map<number, Reaction[]>> {
  const result = new Map<number, Reaction[]>();
  if (messageIds.length === 0) return result;
  const { messageId, emoji, userId, createdAt } = messageReactions;
  const rows = await db
    .select({
      messageId,
      emoji,
      userIds: sql<string[]>`array_agg(${userId} order by ${createdAt}, ${userId})::text[]`,
    })
    .from(messageReactions)
    .where(inArray(messageId, [...messageIds]))
    .groupBy(messageId, emoji)
    .orderBy(asc(messageId), sql`min(${createdAt})`, asc(emoji));
  for (const row of rows) {
    const reaction: Reaction = { emoji: row.emoji, userIds: row.userIds };
    const list = result.get(row.messageId);
    if (list === undefined) result.set(row.messageId, [reaction]);
    else list.push(reaction);
  }
  return result;
}
