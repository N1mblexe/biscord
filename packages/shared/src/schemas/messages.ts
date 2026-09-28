import { z } from 'zod';
import { Emoji } from '../emoji.js';
import { IsoDate, MessageId, MessageIdOrZero, Uuid } from '../ids.js';
import { LIMITS } from '../limits.js';
import { Attachment } from './attachments.js';

/** `count` = `userIds.length`. */
export const Reaction = z.object({
  emoji: Emoji,
  userIds: z.array(Uuid),
});
export type Reaction = z.infer<typeof Reaction>;

export const Message = z.object({
  id: MessageId,
  channelId: Uuid,
  authorId: Uuid,
  content: z.string(),
  createdAt: IsoDate,
  editedAt: IsoDate.nullable(),
  attachments: z.array(Attachment),
  reactions: z.array(Reaction),
  mentionUserIds: z.array(Uuid),
  nonce: z.string().nullable(),
});
export type Message = z.infer<typeof Message>;

export const ReadState = z.object({
  channelId: Uuid,
  lastReadMessageId: MessageIdOrZero,
  unread: z.boolean(),
  mentionCount: z.number().int().nonnegative(),
});
export type ReadState = z.infer<typeof ReadState>;

/** Trimmed message body, ≤ 4000 characters (may be empty). */
export const MessageContent = z.string().trim().max(LIMITS.messageMaxChars);
export type MessageContent = z.infer<typeof MessageContent>;

/**
 * GET `/channels/:id/messages?before=|after=&limit=`.
 * At most one of `before` / `after`; neither = latest page.
 */
export const ListMessagesQuery = z
  .object({
    before: MessageId.optional(),
    after: MessageId.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.messageHistoryPageMax)
      .default(LIMITS.messageHistoryPageDefault),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    error: 'before and after are mutually exclusive',
    path: ['after'],
  });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

/** Messages ascending by id. */
export const ListMessagesResponse = z.object({ messages: z.array(Message) });
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

/** POST `/channels/:id/messages` */
export const CreateMessageRequest = z
  .object({
    content: MessageContent,
    attachmentIds: z
      .array(Uuid)
      .max(LIMITS.attachmentsPerMessage)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'attachmentIds must be unique' })
      .default([]),
    nonce: z.string().max(64).optional(),
  })
  .refine((m) => m.content.length > 0 || m.attachmentIds.length > 0, {
    error: 'Message must have content or at least one attachment',
    path: ['content'],
  });
export type CreateMessageRequest = z.infer<typeof CreateMessageRequest>;

/** PATCH `/messages/:id` */
export const UpdateMessageRequest = z.object({ content: MessageContent });
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequest>;

export const MessageResponse = z.object({ message: Message });
export type MessageResponse = z.infer<typeof MessageResponse>;

/** POST `/channels/:id/read` (forward-only). */
export const MarkReadRequest = z.object({ messageId: MessageId });
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;

export const ReadStateResponse = z.object({ readState: ReadState });
export type ReadStateResponse = z.infer<typeof ReadStateResponse>;

/** `/messages/:id/reactions/:emoji` (emoji URL-decoded by the router). */
export const ReactionParams = z.object({ id: MessageId, emoji: Emoji });
export type ReactionParams = z.infer<typeof ReactionParams>;
