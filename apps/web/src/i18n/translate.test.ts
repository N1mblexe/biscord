import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocaleStore } from './store';
import { dictionaries, interpolate, t, tFor } from './translate';
import type { MessageKey } from './types';

type Writable = Record<string, unknown>;

afterEach(() => {
  useLocaleStore.setState({ locale: 'en' });
  vi.restoreAllMocks();
});

describe('interpolate', () => {
  it('fills {name} placeholders and leaves unknown ones as they are', () => {
    expect(interpolate('Hi {name}, {n} new', { name: 'Ada', n: 3 })).toBe('Hi Ada, 3 new');
    expect(interpolate('Hi {name} {missing}', { name: 'Ada' })).toBe('Hi Ada {missing}');
    expect(interpolate('Hi {name}')).toBe('Hi {name}');
  });
});

describe('tFor', () => {
  it('looks up dotted keys per locale', () => {
    expect(tFor('en', 'common.language.label')).toBe('Language');
    expect(tFor('tr', 'common.language.label')).toBe('Dil');
    expect(tFor('tr', 'common.language.tr')).toBe('Türkçe');
  });

  it('picks English plural forms with Intl.PluralRules', () => {
    expect(tFor('en', 'common.memberCount', { count: 1 })).toBe('1 member');
    expect(tFor('en', 'common.memberCount', { count: 0 })).toBe('0 members');
    expect(tFor('en', 'common.memberCount', { count: 5 })).toBe('5 members');
    expect(tFor('en', 'common.memberCount', { count: '1' })).toBe('1 member');
    // No count: `other`, with the placeholder left in place.
    expect(tFor('en', 'common.memberCount')).toBe('{count} members');
  });

  it('Turkish: nouns stay singular after a number, so every count reads the same', () => {
    expect(new Intl.PluralRules('tr').select(1)).toBe('one');
    expect(tFor('tr', 'common.memberCount', { count: 1 })).toBe('1 üye');
    expect(tFor('tr', 'common.memberCount', { count: 7 })).toBe('7 üye');
  });

  it('uses `zero` for 0 when an entry has it, and `other` when a form is missing', () => {
    const common = dictionaries.en.common as unknown as Writable;
    common.zeroTest = { zero: 'nobody', one: 'one person', other: '{count} people' };
    common.otherOnly = { other: '{count} kişi' };
    try {
      expect(tFor('en', 'common.zeroTest' as MessageKey, { count: 0 })).toBe('nobody');
      expect(tFor('en', 'common.zeroTest' as MessageKey, { count: 1 })).toBe('one person');
      expect(tFor('en', 'common.zeroTest' as MessageKey, { count: 2 })).toBe('2 people');
      expect(tFor('en', 'common.otherOnly' as MessageKey, { count: 1 })).toBe('1 kişi');
    } finally {
      delete common.zeroTest;
      delete common.otherOnly;
    }
  });

  it('falls back to English for a key missing in Turkish, warning in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chat = dictionaries.tr.chat as unknown as Writable;
    const saved = chat.edited;
    delete chat.edited;
    try {
      expect(tFor('tr', 'chat.edited')).toBe('(edited)');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('chat.edited'));
    } finally {
      chat.edited = saved;
    }
    expect(tFor('tr', 'chat.edited')).toBe('(düzenlendi)');
  });

  it('returns the key itself when no language has it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(tFor('tr', 'common.nope' as MessageKey)).toBe('common.nope');
    // A group is not a leaf.
    expect(tFor('en', 'common.language' as MessageKey)).toBe('common.language');
  });
});

describe('t', () => {
  it('follows the current locale in the store', () => {
    expect(t('common.loading')).toBe('Loading…');
    useLocaleStore.setState({ locale: 'tr' });
    expect(t('common.loading')).toBe('Yükleniyor…');
    expect(t('common.memberCount', { count: 2 })).toBe('2 üye');
  });
});
