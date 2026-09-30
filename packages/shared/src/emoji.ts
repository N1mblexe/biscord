import { z } from 'zod';
import { noNul } from './text.js';

/** A single RGI emoji (as stored in `message_reactions.emoji`, varchar 64). */
export const Emoji = z
  .string()
  .max(64)
  .regex(/^\p{RGI_Emoji}$/v);
export type Emoji = z.infer<typeof Emoji>;

/**
 * Response side of an emoji (`Reaction.emoji`, `reaction:*` payloads): any non-empty string up to 64 chars
 * without a NUL. The server only stores emoji that passed `Emoji`, but a browser whose Unicode tables are older
 * than the server's would fail `Emoji` on a newer one, and with it the whole message list.
 */
export const ReactionEmoji = noNul(z.string().min(1).max(64));
export type ReactionEmoji = z.infer<typeof ReactionEmoji>;

/** Quick-pick reaction palette. Every entry is fully qualified and passes `Emoji`. */
export const EMOJI_PALETTE = [
  '👍',
  '👎',
  '❤️',
  '😂',
  '🤣',
  '😊',
  '😍',
  '😎',
  '🤔',
  '😮',
  '😢',
  '😭',
  '😡',
  '😱',
  '🙄',
  '😴',
  '🥳',
  '🤯',
  '😅',
  '😬',
  '🙏',
  '👏',
  '🙌',
  '💪',
  '👀',
  '🔥',
  '✨',
  '🎉',
  '💯',
  '✅',
  '❌',
  '⭐',
  '💀',
  '🤝',
  '👋',
  '🍕',
  '🍺',
  '☕',
  '🎮',
  '🚀',
] as const satisfies readonly string[];
export type PaletteEmoji = (typeof EMOJI_PALETTE)[number];
