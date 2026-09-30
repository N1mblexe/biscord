import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { ListMessagesQuery, Message, ReadState } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { attachments, channels, messages } from '../db/schema.js';
import type { AttachmentRow, MessageRow, Queryable, UserRow } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { toAttachment, toMessage } from '../lib/serialize.js';
import { assertCanPost, loadChannelForUser, type ChannelAccess } from './access.js';
import { attachmentOrder, attachmentsByMessage, storageKeysOfMessage } from './attachments.js';
import { mentionsByMessage, resolveMentions, storeMentions } from './mentions.js';
import { reactionsByMessage } from './reactions.js';
import { rethrowIfGone } from './gone.js';
import {
  advanceReadState,
  changedReadStates,
  getReadState,
  readStatesOfUsers,
  usersCountingMessage,
  type ReadStateChange,
} from './reads.js';

/**
 * `messages.id = <MessageId>`. The id is bound as text and cast in SQL: MessageId allows 16 digits, which
 * can exceed `Number.MAX_SAFE_INTEGER`, so it must never round-trip through a JS number.
 */
const idIs = (id: string): SQL => sql`${messages.id} = ${id}::bigint`;

/**
 * CONTRACTS B.4 row 20, on index `(channel_id, id)`: `before` → the `limit` newest with `id < before`;
 * `after` → the `limit` oldest with `id > after`; neither → the latest page. Always ascending by id.
 */
export async function listMessages(
  db: Queryable,
  channelId: string,
  query: ListMessagesQuery,
): Promise<MessageRow[]> {
  const inChannel = eq(messages.channelId, channelId);
  if (query.after !== undefined) {
    return db
      .select()
      .from(messages)
      .where(and(inChannel, sql`${messages.id} > ${query.after}::bigint`))
      .orderBy(asc(messages.id))
      .limit(query.limit);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(
      query.before === undefined ? inChannel : and(inChannel, sql`${messages.id} < ${query.before}::bigint`),
    )
    .orderBy(desc(messages.id))
    .limit(query.limit);
  return rows.reverse();
}

/**
 * Serializes message rows with their attachments, reactions and mentions: exactly one query each for the
 * whole set, whatever its size (no N+1), and none for an empty set.
 */
export async function toMessages(db: Queryable, rows: readonly MessageRow[]): Promise<Message[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [attachments, reactions, mentions] = await Promise.all([
    attachmentsByMessage(db, ids),
    reactionsByMessage(db, ids),
    mentionsByMessage(db, ids),
  ]);
  return rows.map((row) =>
    toMessage(row, {
      attachments: attachments.get(row.id) ?? [],
      reactions: reactions.get(row.id) ?? [],
      mentionUserIds: mentions.get(row.id) ?? [],
    }),
  );
}

export interface CreateMessageInput {
  /** The target channel, already checked with `loadChannelForUser` + `assertCanPost`. */
  access: ChannelAccess;
  authorId: string;
  /** Already trimmed (shared `MessageContent`). */
  content: string;
  attachmentIds: readonly string[];
  nonce: string | undefined;
}

export interface CreatedMessage {
  message: Message;
  /** The author's read state, moved forward to this message (B.5a rule 3). */
  authorReadState: ReadState;
}

/**
 * One transaction: inserts the message, claims its attachments, stores its mentions (B.5a rules 1–2) and
 * moves the author's read state forward to it. Every attachment id must be an unattached upload of the
 * author (400 VALIDATION "Unknown attachment" otherwise; the claim is a single conditional UPDATE, so two
 * sends can't claim the same file). A channel deleted concurrently → 404 NOT_FOUND (B.9 rule 6).
 */
export async function createMessage(db: Db, input: CreateMessageInput): Promise<CreatedMessage> {
  const channelId = input.access.channel.id;
  const created = db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        channelId,
        authorId: input.authorId,
        content: input.content,
        nonce: input.nonce ?? null,
      })
      .returning();
    if (row === undefined) throw new Error('message insert returned no row');

    let claimed: AttachmentRow[] = [];
    if (input.attachmentIds.length > 0) {
      await tx
        .update(attachments)
        .set({ messageId: row.id })
        .where(
          and(
            inArray(attachments.id, [...input.attachmentIds]),
            eq(attachments.uploaderId, input.authorId),
            isNull(attachments.messageId),
          ),
        );
      // Re-read in display order (UPDATE ... RETURNING has none).
      claimed = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.messageId, row.id))
        .orderBy(...attachmentOrder);
      if (claimed.length !== input.attachmentIds.length) {
        throw new AppError('VALIDATION', 'Unknown attachment');
      }
    }

    const mentioned = await resolveMentions(tx, input.access, input.authorId, input.content);
    const mentionUserIds = await storeMentions(tx, row, mentioned, { replace: false });
    await advanceReadState(tx, input.authorId, channelId, String(row.id));
    const authorReadState = await getReadState(tx, input.authorId, channelId);
    // A new message has no reactions yet.
    const message = toMessage(row, { attachments: claimed.map(toAttachment), reactions: [], mentionUserIds });
    return { message, authorReadState };
  });
  return created.catch(rethrowIfGone);
}

export async function findMessage(db: Queryable, id: string): Promise<MessageRow | null> {
  const [row] = await db.select().from(messages).where(idIs(id));
  return row ?? null;
}

async function loadMessageForUser(
  db: Queryable,
  user: Pick<UserRow, 'id'>,
  id: string,
): Promise<{ message: MessageRow; access: ChannelAccess }> {
  const message = await findMessage(db, id);
  if (message === null) throw new AppError('NOT_FOUND', 'Message not found');
  const access = await loadChannelForUser(db, user, message.channelId);
  return { message, access };
}

/**
 * Takes a `FOR KEY SHARE` lock on the channel row for the rest of the transaction: a concurrent channel
 * delete then waits for this write instead of deadlocking with it (its cascade would wait on our message
 * row lock while our mention inserts' FK checks wait on its channel row lock). Already deleted → 404.
 */
async function lockChannelRow(tx: Queryable, channelId: string): Promise<void> {
  const [row] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.id, channelId))
    .for('key share');
  if (row === undefined) throw new AppError('NOT_FOUND', 'Channel not found');
}

/** An edited or deleted message, and who must get a fresh `readstate:updated` after the commit. */
export interface MessageChange<M> {
  message: M;
  access: ChannelAccess;
  /** Users whose unread flag or mention count the change altered, with their new state (B.9 rule 6). */
  readStates: ReadStateChange[];
}

/**
 * The states of `before`'s users read again after the commit (so what is sent is the latest committed
 * state), keeping only the ones that differ.
 */
async function readStateChanges(
  db: Queryable,
  channelId: string,
  before: ReadonlyMap<string, ReadState>,
): Promise<ReadStateChange[]> {
  if (before.size === 0) return [];
  return changedReadStates(before, await readStatesOfUsers(db, channelId, [...before.keys()]));
}

/**
 * CONTRACTS B.4 row 22: author only (403), not in a read-only DM (403), and the result can't be empty unless
 * the message has attachments (400). Sets `editedAt` and recomputes the mentions in the same transaction
 * (B.5a rule 2). Returns the serialized message (with its reactions), the channel access and the users whose
 * mention count the edit changed (B.9 rule 6).
 */
export async function editMessage(
  db: Db,
  user: Pick<UserRow, 'id'>,
  id: string,
  content: string,
): Promise<MessageChange<Message>> {
  const { message, access } = await loadMessageForUser(db, user, id);
  if (message.authorId !== user.id) throw new AppError('FORBIDDEN', 'You can only edit your own messages');
  await assertCanPost(db, access);

  if (content.length === 0) {
    const [row] = await db
      .select({ n: count() })
      .from(attachments)
      .where(eq(attachments.messageId, message.id));
    if ((row?.n ?? 0) === 0) {
      throw new AppError('VALIDATION', 'Message must have content or at least one attachment');
    }
  }

  const { updated, before } = await db.transaction(async (tx) => {
    await lockChannelRow(tx, message.channelId);
    const [row] = await tx
      .update(messages)
      .set({ content, editedAt: sql`now()` })
      .where(eq(messages.id, message.id))
      .returning();
    if (row === undefined) throw new AppError('NOT_FOUND', 'Message not found');
    const mentioned = await resolveMentions(tx, access, user.id, content);
    // Only a user added to or dropped from the mentions can see their mention count move.
    const previous = (await mentionsByMessage(tx, [row.id])).get(row.id) ?? [];
    const toggled = [
      ...previous.filter((userId) => !mentioned.includes(userId)),
      ...mentioned.filter((userId) => !previous.includes(userId)),
    ];
    const affected = await usersCountingMessage(tx, access, row, toggled);
    const states = await readStatesOfUsers(tx, row.channelId, affected);
    await storeMentions(tx, row, mentioned, { replace: true });
    return { updated: row, before: states };
  });
  const [serialized] = await toMessages(db, [updated]);
  if (serialized === undefined) throw new Error('serializing the edited message returned nothing');
  const readStates = await readStateChanges(db, updated.channelId, before);
  return { message: serialized, access, readStates };
}

/**
 * CONTRACTS B.4 row 23: the author, or an admin in a text/voice channel (never in a DM). 403 otherwise.
 * Returns the deleted message, its channel's access (for the broadcast), the users whose unread flag or
 * mention count the delete changed (B.9 rule 6) and the storage keys of its attachments, which the caller
 * unlinks after the commit (B.7).
 */
export async function deleteMessage(
  db: Db,
  user: Pick<UserRow, 'id' | 'role'>,
  id: string,
): Promise<MessageChange<MessageRow> & { storageKeys: string[] }> {
  const { message, access } = await loadMessageForUser(db, user, id);
  const isAuthor = message.authorId === user.id;
  const isChannelAdmin = user.role === 'admin' && access.channel.type !== 'dm';
  if (!isAuthor && !isChannelAdmin) {
    throw new AppError('FORBIDDEN', 'You cannot delete this message');
  }

  // B.7 "delete message": collect the storage keys in the transaction; the delete cascades to the
  // attachment rows. Attachments are only ever claimed by a new message, so the set can't grow meanwhile.
  const { storageKeys, before } = await db.transaction(async (tx) => {
    // Lock the row first, so no mention edit commits between reading the states and the delete.
    const [locked] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, message.id))
      .for('update');
    if (locked === undefined) throw new AppError('NOT_FOUND', 'Message not found');
    const affected = await usersCountingMessage(tx, access, message);
    const states = await readStatesOfUsers(tx, message.channelId, affected);
    const keys = await storageKeysOfMessage(tx, message.id);
    await tx.delete(messages).where(eq(messages.id, message.id));
    return { storageKeys: keys, before: states };
  });
  const readStates = await readStateChanges(db, message.channelId, before);
  return { message, access, storageKeys, readStates };
}

/**
 * Test mode only (B.4 row 40): inserts `"<prefix> 1".."<prefix> n"` in one statement, ids ascending with
 * the numbering. No broadcast, no rate limit.
 */
export async function seedMessages(
  db: Queryable,
  input: { channelId: string; authorId: string; count: number; prefix: string },
): Promise<{ firstId: number; lastId: number }> {
  const rows = await db
    .insert(messages)
    .values(
      Array.from({ length: input.count }, (_, i) => ({
        channelId: input.channelId,
        authorId: input.authorId,
        content: `${input.prefix} ${i + 1}`,
      })),
    )
    .returning({ id: messages.id });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) throw new Error('seed insert returned no rows');
  return { firstId: Math.min(...ids), lastId: Math.max(...ids) };
}
