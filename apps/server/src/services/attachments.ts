import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { LIMITS, type Attachment } from '@hearth/shared';
import { attachments, messages } from '../db/schema.js';
import type { AttachmentRow, Queryable, UserRow } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { toAttachment } from '../lib/serialize.js';
import { loadChannelForUser } from './access.js';

export interface NewAttachment {
  uploaderId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Inserts an unattached upload (row 27); send (row 21) claims it later. */
export async function insertAttachment(db: Queryable, input: NewAttachment): Promise<AttachmentRow> {
  const [row] = await db.insert(attachments).values(input).returning();
  if (row === undefined) throw new Error('attachment insert returned no row');
  return row;
}

export interface UnattachedUsage {
  files: number;
  bytes: number;
}

/** How many unattached uploads `uploaderId` has, and their total size. */
export async function unattachedUsage(db: Queryable, uploaderId: string): Promise<UnattachedUsage> {
  const [row] = await db
    .select({
      files: count(),
      // sum() of an integer column is a bigint, which pg returns as a string.
      bytes: sql<string>`coalesce(sum(${attachments.sizeBytes}), 0)`,
    })
    .from(attachments)
    .where(and(eq(attachments.uploaderId, uploaderId), isNull(attachments.messageId)));
  return { files: row?.files ?? 0, bytes: Number(row?.bytes ?? 0) };
}

/**
 * CONTRACTS B.7a rule 8: before streaming, refuse (409 UPLOAD_QUOTA) when the user already has
 * `LIMITS.unattachedUploadsMaxFiles` unattached uploads or `LIMITS.unattachedUploadsMaxBytes` of them.
 * Sending them in a message (or the 24 h GC) frees the quota.
 */
export async function ensureUploadQuota(db: Queryable, uploaderId: string): Promise<void> {
  const usage = await unattachedUsage(db, uploaderId);
  if (usage.files >= LIMITS.unattachedUploadsMaxFiles || usage.bytes >= LIMITS.unattachedUploadsMaxBytes) {
    throw new AppError('UPLOAD_QUOTA', 'Too many files waiting to be sent. Send or remove some first.');
  }
}

/** Stable display order within a message: upload time, then id. */
export const attachmentOrder = [asc(attachments.createdAt), asc(attachments.id)] as const;

/** `Attachment[]` for a set of messages in one query; messages without attachments are absent. */
export async function attachmentsByMessage(
  db: Queryable,
  messageIds: readonly number[],
): Promise<Map<number, Attachment[]>> {
  const result = new Map<number, Attachment[]>();
  if (messageIds.length === 0) return result;
  const rows = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.messageId, [...messageIds]))
    .orderBy(asc(attachments.messageId), ...attachmentOrder);
  for (const row of rows) {
    if (row.messageId === null) continue;
    const list = result.get(row.messageId);
    if (list === undefined) result.set(row.messageId, [toAttachment(row)]);
    else list.push(toAttachment(row));
  }
  return result;
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'Attachment not found');

/**
 * CONTRACTS B.4 row 28 / B.7a rule 4: an attached file is readable by anyone with access to its message's
 * channel; an unattached one only by its uploader. Everything else (unknown id, no access, someone else's
 * unattached upload) is 404 NOT_FOUND, so existence isn't revealed.
 */
export async function loadAttachmentForUser(
  db: Queryable,
  user: Pick<UserRow, 'id'>,
  id: string,
): Promise<AttachmentRow> {
  const [row] = await db
    .select({ attachment: attachments, channelId: messages.channelId })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(eq(attachments.id, id));
  if (row === undefined) throw notFound();
  const { attachment, channelId } = row;

  if (attachment.messageId === null) {
    if (attachment.uploaderId !== user.id) throw notFound();
    return attachment;
  }
  if (channelId === null) throw notFound();
  try {
    await loadChannelForUser(db, user, channelId);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) throw notFound();
    throw err;
  }
  return attachment;
}

/** Storage keys of a message's attachments (collected before a delete, B.7). */
export async function storageKeysOfMessage(db: Queryable, messageId: number): Promise<string[]> {
  const rows = await db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.messageId, messageId));
  return rows.map((row) => row.key);
}

/** Storage keys of every attachment in a channel (collected before a channel delete, B.7). */
export async function storageKeysOfChannel(db: Queryable, channelId: string): Promise<string[]> {
  const rows = await db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(eq(messages.channelId, channelId));
  return rows.map((row) => row.key);
}
