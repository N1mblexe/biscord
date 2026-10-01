import { describe, expect, it } from 'vitest';
import { dayLabel, GROUP_WINDOW_MS, timelineMeta } from './chatTimeline';

const A = 'author-a';
const B = 'author-b';
// Local times, so the day boundaries don't depend on the machine's time zone.
const NOW = new Date(2026, 8, 30, 15, 0);
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 8, day, hour, minute, second).toISOString();

describe('dayLabel', () => {
  it('says Today, Yesterday, then the full date', () => {
    expect(dayLabel(new Date(2026, 8, 30, 0, 1), NOW)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 29, 23, 59), NOW)).toBe('Yesterday');
    const older = dayLabel(new Date(2026, 8, 28, 12), NOW);
    expect(older).not.toMatch(/Today|Yesterday/);
    expect(older).toContain('2026');
  });

  it('handles month boundaries for Yesterday', () => {
    expect(dayLabel(new Date(2026, 8, 30, 9), new Date(2026, 9, 1, 8))).toBe('Yesterday');
  });
});

describe('timelineMeta', () => {
  it('groups same-author messages within 5 minutes and separates days', () => {
    const meta = timelineMeta(
      [
        { authorId: A, createdAt: at(29, 23, 58) },
        { authorId: A, createdAt: at(30, 0, 1) }, // new day: separator, not grouped
        { authorId: A, createdAt: at(30, 0, 3) }, // grouped
        { authorId: B, createdAt: at(30, 0, 4) }, // other author
        { authorId: B, createdAt: at(30, 0, 9) }, // exactly 5 min: grouped
        { authorId: B, createdAt: at(30, 0, 14, 1) }, // just over 5 min
      ],
      NOW,
    );
    expect(meta).toEqual([
      { separator: 'Yesterday', grouped: false },
      { separator: 'Today', grouped: false },
      { separator: null, grouped: true },
      { separator: null, grouped: false },
      { separator: null, grouped: true },
      { separator: null, grouped: false },
    ]);
    expect(GROUP_WINDOW_MS).toBe(300_000);
  });

  it('never groups the first item or an item older than its predecessor', () => {
    const meta = timelineMeta(
      [
        { authorId: A, createdAt: at(30, 10, 5) },
        { authorId: A, createdAt: at(30, 10, 4) },
      ],
      NOW,
    );
    expect(meta.map((m) => m.grouped)).toEqual([false, false]);
    expect(timelineMeta([], NOW)).toEqual([]);
  });

  it('labels separators in the given language', () => {
    const meta = timelineMeta(
      [
        { authorId: A, createdAt: at(29, 9) },
        { authorId: A, createdAt: at(30, 9) },
      ],
      NOW,
      'tr',
    );
    expect(meta.map((m) => m.separator)).toEqual(['Dün', 'Bugün']);
  });
});
