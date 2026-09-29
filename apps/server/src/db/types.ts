import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

/** Either the pooled database or a transaction: every query helper accepts both. */
export type Queryable = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export type UserRow = typeof schema.users.$inferSelect;
export type SessionRow = typeof schema.sessions.$inferSelect;
export type InviteRow = typeof schema.invites.$inferSelect;
export type ChannelRow = typeof schema.channels.$inferSelect;
export type DmChannelRow = typeof schema.dmChannels.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
export type AttachmentRow = typeof schema.attachments.$inferSelect;

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

/** drizzle wraps driver errors in `DrizzleQueryError`; the pg error is its `cause`. */
function pgError(err: unknown): PgErrorLike {
  const candidate = err instanceof Error && err.cause !== undefined ? err.cause : err;
  return typeof candidate === 'object' && candidate !== null ? candidate : {};
}

/** True for a Postgres unique violation (23505), optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const { code, constraint: actual } = pgError(err);
  return code === '23505' && (constraint === undefined || actual === constraint);
}
