import { z } from 'zod';

/** UUID (any version). */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** Message ids are Postgres bigints and travel as decimal strings (no leading zeros, never `'0'`). */
export const MessageId = z.string().regex(/^[1-9]\d{0,15}$/);
export type MessageId = z.infer<typeof MessageId>;

/** A MessageId, or `'0'` meaning "nothing read yet" (ReadState.lastReadMessageId). */
export const MessageIdOrZero = z.union([MessageId, z.literal('0')]);
export type MessageIdOrZero = z.infer<typeof MessageIdOrZero>;

/** ISO 8601 datetime string; `Z` or a numeric offset. */
export const IsoDate = z.iso.datetime({ offset: true });
export type IsoDate = z.infer<typeof IsoDate>;
