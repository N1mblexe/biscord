/**
 * Day separators and author grouping for the chat history (docs/plans/polish.md, area 2).
 *
 * - A separator starts every local calendar day ("Today", "Yesterday", then the full date).
 * - A message is *grouped* (drawn without avatar and author line) when the previous message in the
 *   list is by the same author, on the same day, and at most `GROUP_WINDOW_MS` older.
 */

/** Consecutive messages by one author this close together share one header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export interface TimelineInput {
  authorId: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface TimelineMeta {
  /** The day separator's label drawn before this item, or `null` (same day as the previous one). */
  separator: string | null;
  /** Drawn without its own avatar and author line. */
  grouped: boolean;
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today", "Yesterday" or the full local date, relative to `now`. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Separator and grouping for each item of a history in display (ascending) order. */
export function timelineMeta(items: readonly TimelineInput[], now: Date = new Date()): TimelineMeta[] {
  const out: TimelineMeta[] = [];
  let prev: { authorId: string; time: number; day: string } | null = null;
  for (const item of items) {
    const date = new Date(item.createdAt);
    const time = date.getTime();
    const day = localDayKey(date);
    const newDay = prev?.day !== day;
    const grouped =
      prev !== null &&
      !newDay &&
      prev.authorId === item.authorId &&
      time >= prev.time &&
      time - prev.time <= GROUP_WINDOW_MS;
    out.push({ separator: newDay ? dayLabel(date, now) : null, grouped });
    prev = { authorId: item.authorId, time, day };
  }
  return out;
}
