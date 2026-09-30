import { describe, expect, it } from 'vitest';
import {
  EMOJI_PALETTE,
  Emoji,
  ListMessagesResponse,
  ReactionEmoji,
  ReactionEventPayload,
} from '../src/index.js';

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

describe('ReactionEmoji (response side)', () => {
  // A codepoint the regex tables may not know yet (a browser older than the server's Unicode version).
  const unknownToRegex = '\u{1FAE9}\u{1F3FD}\u{200D}\u{1FAE9}';

  it('accepts any non-empty string up to 64 chars, even one Emoji rejects', () => {
    expect(ReactionEmoji.safeParse('👍').success).toBe(true);
    expect(ReactionEmoji.safeParse(unknownToRegex).success).toBe(true);
    expect(ReactionEmoji.safeParse('a').success).toBe(true);
  });

  it('rejects empty, overlong and NUL-carrying values', () => {
    expect(ReactionEmoji.safeParse('').success).toBe(false);
    expect(ReactionEmoji.safeParse('x'.repeat(65)).success).toBe(false);
    expect(ReactionEmoji.safeParse('👍\u0000').success).toBe(false);
  });

  it('one unknown emoji does not fail a whole message list or a reaction event', () => {
    const message = {
      id: '1',
      channelId: '3f2c1b9e-8a4d-4c6b-9f1e-2d3c4b5a6f70',
      authorId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      content: 'hi',
      createdAt: '2026-09-30T12:00:00.000Z',
      editedAt: null,
      attachments: [],
      reactions: [{ emoji: 'not-an-rgi-emoji', userIds: [] }],
      mentionUserIds: [],
      nonce: null,
    };
    expect(ListMessagesResponse.safeParse({ messages: [message] }).success).toBe(true);
    expect(
      ReactionEventPayload.safeParse({
        channelId: message.channelId,
        messageId: '1',
        emoji: 'not-an-rgi-emoji',
        userId: message.authorId,
      }).success,
    ).toBe(true);
  });
});
