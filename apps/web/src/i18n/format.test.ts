import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compare,
  dayLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  upper,
} from './format';
import { useLocaleStore } from './store';

// Local times, so the day boundaries don't depend on the machine's time zone.
const NOW = new Date(2026, 8, 30, 15, 0);
const AT = new Date(2026, 8, 30, 15, 5);

beforeEach(() => {
  // A fixed browser language so the regional variant is predictable (en → en-US, tr → tr).
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useLocaleStore.setState({ locale: 'en' });
});

describe('dates', () => {
  it('formats in English', () => {
    expect(formatTime(AT, 'en')).toBe('03:05 PM');
    expect(formatDate(AT, 'en')).toBe('Sep 30, 2026');
    expect(formatDateTime(AT.toISOString(), 'en')).toMatch(/^Sep 30, 2026, 3:05\sPM$/);
  });

  it('formats in Turkish', () => {
    expect(formatTime(AT, 'tr')).toBe('15:05');
    expect(formatDate(AT, 'tr')).toBe('30 Eyl 2026');
    expect(formatDateTime(AT, 'tr')).toBe('30 Eyl 2026 15:05');
  });

  it('uses the store locale by default', () => {
    useLocaleStore.setState({ locale: 'tr' });
    expect(formatTime(AT)).toBe('15:05');
  });

  it('keeps the browser regional variant of the same language', () => {
    vi.stubGlobal('navigator', { language: 'en-GB', languages: ['en-GB'] });
    expect(formatTime(AT, 'en')).toBe('15:05');
  });
});

describe('dayLabel', () => {
  it('says Today, Yesterday, then the full date in English', () => {
    expect(dayLabel(new Date(2026, 8, 30, 0, 1), NOW, 'en')).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 29, 23, 59), NOW, 'en')).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 28, 12), NOW, 'en')).toBe('Monday, September 28, 2026');
  });

  it('says Bugün, Dün, then the full date in Turkish', () => {
    expect(dayLabel(new Date(2026, 8, 30, 0, 1), NOW, 'tr')).toBe('Bugün');
    expect(dayLabel(new Date(2026, 8, 29, 23, 59), NOW, 'tr')).toBe('Dün');
    expect(dayLabel(new Date(2026, 8, 28, 12), NOW, 'tr')).toBe('28 Eylül 2026 Pazartesi');
  });

  it('handles month boundaries', () => {
    expect(dayLabel(new Date(2026, 8, 30, 9), new Date(2026, 9, 1, 8), 'tr')).toBe('Dün');
  });
});

describe('numbers', () => {
  it('formatBytes keeps the English output and uses the Turkish decimal comma', () => {
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1023, 'en')).toBe('1023 B');
    expect(formatBytes(1024 * 1024 - 1, 'en')).toBe('1 MB');
    expect(formatBytes(1536, 'tr')).toBe('1,5 KB');
    expect(formatBytes(2.25 * 1024 * 1024, 'tr')).toBe('2,3 MB');
    expect(formatBytes(-1, 'tr')).toBe('0 B');
  });

  it('formatNumber groups per locale', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(1234.5, 'tr')).toBe('1.234,5');
  });
});

describe('compare', () => {
  it('sorts Turkish letters in Turkish order', () => {
    const words = [
      'şeker',
      'sabah',
      'ılık',
      'iğne',
      'zeytin',
      'hava',
      'çay',
      'cam',
      'ürün',
      'uzun',
      'ördek',
      'oda',
    ];
    expect(words.toSorted((a, b) => compare(a, b, 'tr'))).toEqual([
      'cam',
      'çay',
      'hava',
      'ılık',
      'iğne',
      'oda',
      'ördek',
      'sabah',
      'şeker',
      'uzun',
      'ürün',
      'zeytin',
    ]);
  });

  it('ignores case (base sensitivity)', () => {
    expect(compare('alice', 'Alice', 'en')).toBe(0);
    expect(compare('alice', 'bob', 'en')).toBeLessThan(0);
  });
});

describe('upper', () => {
  it('upper-cases in the rules of the language', () => {
    expect(upper('i', 'tr')).toBe('İ');
    expect(upper('ı', 'tr')).toBe('I');
    expect(upper('i', 'en')).toBe('I');
  });
});
