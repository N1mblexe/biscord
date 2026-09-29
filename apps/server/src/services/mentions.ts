import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { messageMentions, users } from '../db/schema.js';
import type { Queryable } from '../db/types.js';
import type { ChannelAccess } from './access.js';

/** CONTRACTS B.5a rule 2. Not preceded by a word character or another `@`. */
const MENTION_PATTERN = /(?<![\w@])@([a-z0-9_]{3,32})/gi;

/** Lower-cased, de-duplicated usernames mentioned in `content`, in order of first appearance. */
export function parseMentionUsernames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.add(name.toLowerCase());
  }
  return [...names];
}

/** Canonical order of `mentionUserIds` (matches Postgres uuid order: canonical strings are lower-case). */
function sortIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Who a message mentions (B.5a rules 1–2). A DM always mentions the other member and nobody else can be
 * mentioned there. In a text channel: active users whose username appears in `content`, never the author.
 */
export async function resolveMentions(
  db: Queryable,
  access: ChannelAccess,
  authorId: string,
  content: string,
): Promise<string[]> {
  if (access.dm !== null) return [access.dm.otherUserId];
  const names = parseMentionUsernames(content);
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.username, names), isNull(users.deactivatedAt), ne(users.id, authorId)));
  return sortIds(rows.map((row) => row.id));
}

/**
 * Replaces the mention rows of a message (create: nothing to delete; edit: recompute). Call inside the
 * message's transaction. Returns the sorted ids.
 */
export async function storeMentions(
  tx: Queryable,
  message: { id: number; channelId: string },
  userIds: readonly string[],
  { replace }: { replace: boolean },
): Promise<string[]> {
  if (replace) await tx.delete(messageMentions).where(eq(messageMentions.messageId, message.id));
  const ids = sortIds(userIds);
  if (ids.length > 0) {
    await tx
      .insert(messageMentions)
      .values(ids.map((userId) => ({ messageId: message.id, userId, channelId: message.channelId })));
  }
  return ids;
}

/** `mentionUserIds` for a set of messages, in one query. Messages without mentions are absent. */
export async function mentionsByMessage(
  db: Queryable,
  messageIds: readonly number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (messageIds.length === 0) return result;
  const rows = await db
    .select({ messageId: messageMentions.messageId, userId: messageMentions.userId })
    .from(messageMentions)
    .where(inArray(messageMentions.messageId, [...messageIds]))
    .orderBy(asc(messageMentions.messageId), asc(messageMentions.userId));
  for (const row of rows) {
    const list = result.get(row.messageId);
    if (list === undefined) result.set(row.messageId, [row.userId]);
    else list.push(row.userId);
  }
  return result;
}
