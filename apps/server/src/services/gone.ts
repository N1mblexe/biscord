import { isForeignKeyViolation } from '../db/types.js';
import { AppError } from '../lib/errors.js';

/** Foreign keys onto `channels` that a write can hit while the channel is being deleted. */
const CHANNEL_FKS = [
  'messages_channel_id_channels_id_fk',
  'message_mentions_channel_id_channels_id_fk',
  'read_states_channel_id_channels_id_fk',
] as const;

/** Foreign keys onto `messages` (a channel delete cascades to its messages). */
const MESSAGE_FKS = [
  'message_mentions_message_id_messages_id_fk',
  'message_reactions_message_id_messages_id_fk',
  'attachments_message_id_messages_id_fk',
] as const;

/**
 * CONTRACTS B.9 rule 6: a write into a channel (or onto a message) that was deleted concurrently is a
 * 404 NOT_FOUND, never a 500. The access check ran before the delete committed; the FK check inside the
 * write waits for the delete's transaction and then fails with 23503. Use as `.catch(rethrowIfGone)`;
 * anything else is rethrown unchanged.
 */
export function rethrowIfGone(err: unknown): never {
  if (isForeignKeyViolation(err, CHANNEL_FKS)) throw new AppError('NOT_FOUND', 'Channel not found');
  if (isForeignKeyViolation(err, MESSAGE_FKS)) throw new AppError('NOT_FOUND', 'Message not found');
  throw err;
}
