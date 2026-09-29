import { LIMITS } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_COLORS,
  AVATAR_SIZE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  avatarColor,
  checkAvatarFile,
  initials,
} from './avatar';

describe('initials', () => {
  it.each([
    ['Alice', 'A'],
    ['alice smith', 'AS'],
    ['  Bob   the  Builder ', 'BT'],
    ['Élodie Ünal', 'ÉÜ'],
    ['😀 Smile', '😀S'],
    ['', '?'],
    ['   ', '?'],
  ])('%j → %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe('avatarColor', () => {
  it('is stable for a seed and drawn from the palette', () => {
    const id = '6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a';
    expect(avatarColor(id)).toBe(avatarColor(id));
    expect(AVATAR_COLORS).toContain(avatarColor(id));
    expect(AVATAR_COLORS).toContain(avatarColor(''));
  });

  it('spreads different users over several colors', () => {
    const colors = new Set(Array.from({ length: 50 }, (_, i) => avatarColor(`user-${i}`)));
    expect(colors.size).toBeGreaterThan(3);
  });
});

describe('checkAvatarFile', () => {
  it('accepts png, jpeg and webp up to 2 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(checkAvatarFile({ type, size: LIMITS.avatarMaxBytes })).toBeNull();
    }
  });

  it('rejects other types', () => {
    expect(AVATAR_TYPE_MESSAGE).toBe('Avatar must be a PNG, JPEG or WebP image.');
    for (const type of ['image/gif', 'image/svg+xml', 'text/html', '']) {
      expect(checkAvatarFile({ type, size: 10 })).toBe(AVATAR_TYPE_MESSAGE);
    }
  });

  it('rejects files over 2 MB', () => {
    expect(checkAvatarFile({ type: 'image/png', size: LIMITS.avatarMaxBytes + 1 })).toBe(AVATAR_SIZE_MESSAGE);
  });
});
