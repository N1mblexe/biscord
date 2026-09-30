import type { Locale } from '@hearth/shared';
import { getLocale } from './store';

/**
 * Locale-aware formatting on `Intl`, in the UI language (the current one unless `locale` is passed).
 *
 * Dates and numbers use the browser's regional variant when it is the same language (an `en-GB`
 * browser keeps 24-hour times and day-first dates in English); sorting and upper-casing use the
 * language itself (what matters there is Turkish `ı/i/İ`, `ş`, …).
 */

export type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function regionalTag(locale: Locale): string {
  if (typeof navigator === 'undefined') return locale;
  const { languages, language } = navigator as Partial<Navigator>;
  const preferred: readonly unknown[] =
    Array.isArray(languages) && languages.length > 0 ? languages : [language];
  for (const tag of preferred) {
    if (typeof tag !== 'string' || tag.toLowerCase().split('-')[0] !== locale) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? locale;
    } catch {
      // Malformed tag: use the plain language.
    }
  }
  return locale;
}

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const value = make();
  cache.set(key, value);
  return value;
}

function dateFormat(locale: Locale, name: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = regionalTag(locale);
  return cached(`dt|${name}|${tag}`, () => new Intl.DateTimeFormat(tag, options));
}

/** `15:05` / `03:05 PM`: a message's time. */
export function formatTime(date: DateInput, locale: Locale = getLocale()): string {
  return dateFormat(locale, 'time', { hour: '2-digit', minute: '2-digit' }).format(toDate(date));
}

/** `Sep 30, 2026, 3:05 PM` / `30 Eyl 2026 15:05`: tooltips and expiry times. */
export function formatDateTime(date: DateInput, locale: Locale = getLocale()): string {
  return dateFormat(locale, 'dateTime', { dateStyle: 'medium', timeStyle: 'short' }).format(toDate(date));
}

/** `Sep 30, 2026` / `30 Eyl 2026`. */
export function formatDate(date: DateInput, locale: Locale = getLocale()): string {
  return dateFormat(locale, 'date', { dateStyle: 'medium' }).format(toDate(date));
}

function localDayKey(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`;
}

/** Upper-cases the first letter in the rules of `locale` ("bugün" → "Bugün", "today" → "Today"). */
function capitalize(text: string, locale: Locale): string {
  return text.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase(locale));
}

/**
 * A chat day separator relative to `now` (local calendar days): "Today", "Yesterday" (from
 * `Intl.RelativeTimeFormat`, capitalized), otherwise the full date with the weekday.
 */
export function dayLabel(date: DateInput, now: Date = new Date(), locale: Locale = getLocale()): string {
  const day = toDate(date);
  const key = localDayKey(day);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const offset = key === localDayKey(now) ? 0 : key === localDayKey(yesterday) ? -1 : null;
  if (offset !== null) {
    const tag = regionalTag(locale);
    const relative = cached(`rt|${tag}`, () => new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }));
    return capitalize(relative.format(offset, 'day'), locale);
  }
  return dateFormat(locale, 'day', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(day);
}

/** `1,234` / `1.234`. */
export function formatNumber(n: number, locale: Locale = getLocale()): string {
  const tag = regionalTag(locale);
  return cached(`num|${tag}`, () => new Intl.NumberFormat(tag)).format(n);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Human-readable size with 1024-based units (the same units as the limits: 25 MB = 25 × 1024²).
 * Below 10 of a unit one decimal is kept (a trailing `.0` dropped); from 10 up it is rounded. The
 * number uses the locale's decimal separator (`1.5 KB` / `1,5 KB`), without grouping.
 */
export function formatBytes(bytes: number, locale: Locale = getLocale()): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let rounded = unit === 0 ? Math.round(value) : value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  // 1023.7 KB rounds to 1024 KB: show it as 1 MB instead.
  if (rounded >= 1024 && unit > 0 && unit < BYTE_UNITS.length - 1) {
    rounded = 1;
    unit += 1;
  }
  const tag = regionalTag(locale);
  const number = cached(
    `bytes|${tag}`,
    () => new Intl.NumberFormat(tag, { maximumFractionDigits: 1, useGrouping: false }),
  );
  return `${number.format(rounded)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** Sorts names the way the language does (`sensitivity: 'base'`: case and accents don't separate). */
export function compare(a: string, b: string, locale: Locale = getLocale()): number {
  return cached(`coll|${locale}`, () => new Intl.Collator(locale, { sensitivity: 'base' })).compare(a, b);
}

/** Upper-cases in the rules of the language (Turkish `i` → `İ`). */
export function upper(text: string, locale: Locale = getLocale()): string {
  return text.toLocaleUpperCase(locale);
}
