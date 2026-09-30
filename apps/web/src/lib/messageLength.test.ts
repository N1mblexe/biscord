import { LIMITS } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import { MESSAGE_INPUT_MAX_LENGTH, messageLength, messageTooLong } from './messageLength';

describe('messageLength', () => {
  it('counts code points, like the server, not UTF-16 units', () => {
    expect(messageLength('')).toBe(0);
    expect(messageLength('abc')).toBe(3);
    expect('😀'.length).toBe(2);
    expect(messageLength('😀')).toBe(1);
    expect(messageLength('a😀b')).toBe(3);
  });
});

describe('messageTooLong', () => {
  it('accepts exactly the limit in emoji and rejects one more', () => {
    const max = '😀'.repeat(LIMITS.messageMaxChars);
    expect(max.length).toBeLessThanOrEqual(MESSAGE_INPUT_MAX_LENGTH);
    expect(messageTooLong(max)).toBeNull();
    expect(messageTooLong(`${max}a`)).toBe(`Messages can be at most ${LIMITS.messageMaxChars} characters.`);
  });
});
