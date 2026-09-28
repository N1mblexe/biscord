import { z } from 'zod';

/** A single RGI emoji (as stored in `message_reactions.emoji`, varchar 64). */
export const Emoji = z
  .string()
  .max(64)
  .regex(/^\p{RGI_Emoji}$/v);
export type Emoji = z.infer<typeof Emoji>;

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
