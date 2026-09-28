import { describe, expect, it } from 'vitest';
import { EMOJI_PALETTE, Emoji } from '../src/index.js';

describe('Emoji', () => {
  it.each(EMOJI_PALETTE)('palette entry %s passes the Emoji schema', (emoji) => {
    expect(Emoji.safeParse(emoji).success).toBe(true);
  });

  it('has unique palette entries', () => {
    expect(new Set(EMOJI_PALETTE).size).toBe(EMOJI_PALETTE.length);
  });

  it('accepts multi-codepoint RGI sequences', () => {
    expect(Emoji.safeParse('👨‍👩‍👧').success).toBe(true);
    expect(Emoji.safeParse('👍🏽').success).toBe(true);
  });

  it('rejects text, multiple emoji and empty strings', () => {
    expect(Emoji.safeParse('a').success).toBe(false);
    expect(Emoji.safeParse('👍👍').success).toBe(false);
    expect(Emoji.safeParse('').success).toBe(false);
    expect(Emoji.safeParse(' 👍').success).toBe(false);
  });
});
