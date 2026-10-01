import { LIMITS } from '@hearth/shared';
import { t } from '../i18n/translate';

/**
 * A message's length as the server counts it: in Unicode code points (Postgres `char_length`), so
 * an emoji is one character, not the two UTF-16 units of `String.length`.
 */
export function messageLength(content: string): number {
  // Code points are exactly what we want here (Postgres counts them, not graphemes).
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- counting code points on purpose
  return [...content].length;
}

/** The error text for a message over the limit (in the UI language), or `null` when it fits. */
export function messageTooLong(content: string): string | null {
  return messageLength(content) > LIMITS.messageMaxChars
    ? t('chat.message.tooLong', { max: LIMITS.messageMaxChars })
    : null;
}

/**
 * The textarea's `maxLength`, which the browser counts in UTF-16 units: room for the limit in code
 * points even when every one of them takes two units (the real check is `messageTooLong`).
 */
export const MESSAGE_INPUT_MAX_LENGTH = LIMITS.messageMaxChars * 2;
