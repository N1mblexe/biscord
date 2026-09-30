import { DEFAULT_LOCALE, LOCALES, type Locale } from '@hearth/shared';

/** localStorage key of the language chosen in this browser (CONTRACTS B.11 rule 3). */
export const LANGUAGE_STORAGE_KEY = 'hearth:language';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The stored choice, or `null` when there is none, it is invalid, or storage is blocked. */
export function readStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts for this page only.
  }
}

/** `'tr'` when the browser's language is Turkish (`tr`, `tr-TR`, …), otherwise `null`. */
export function browserLocale(): Locale | null {
  const language = typeof navigator === 'undefined' ? undefined : navigator.language;
  return typeof language === 'string' && language.toLowerCase().startsWith('tr') ? 'tr' : null;
}

/**
 * The language before login (CONTRACTS B.11 rule 3): the stored choice, then a Turkish browser
 * language, then English. After login the account's `locale` wins (the caller applies it).
 */
export function detectInitialLocale(): Locale {
  return readStoredLocale() ?? browserLocale() ?? DEFAULT_LOCALE;
}
