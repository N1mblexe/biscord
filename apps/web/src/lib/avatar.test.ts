import { LIMITS } from '@hearth/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n/store';
import { AVATAR_COLORS, avatarColor, checkAvatarFile, initials } from './avatar';

const TYPE_MESSAGE = 'Avatar must be a PNG, JPEG or WebP image.';
const SIZE_MESSAGE = 'Avatar must be at most 2 MB.';

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
    for (const type of ['image/gif', 'image/svg+xml', 'text/html', '']) {
      expect(checkAvatarFile({ type, size: 10 })).toBe(TYPE_MESSAGE);
    }
  });

  it('rejects files over 2 MB', () => {
    expect(checkAvatarFile({ type: 'image/png', size: LIMITS.avatarMaxBytes + 1 })).toBe(SIZE_MESSAGE);
  });

  describe('in Turkish', () => {
    afterEach(() => {
      useLocaleStore.setState({ locale: 'en' });
    });

    it('explains the rejection in the UI language', () => {
      useLocaleStore.setState({ locale: 'tr' });
      expect(checkAvatarFile({ type: 'image/gif', size: 10 })).toBe(
        'Avatar PNG, JPEG ya da WebP görseli olmalı.',
      );
      expect(checkAvatarFile({ type: 'image/png', size: LIMITS.avatarMaxBytes + 1 })).toBe(
        'Avatar en fazla 2 MB olabilir.',
      );
    });
  });
});
