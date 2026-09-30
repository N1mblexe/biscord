import { DEFAULT_LOCALE, type Locale } from '@hearth/shared';
import { create } from 'zustand';
import { detectInitialLocale, writeStoredLocale } from './detect';

export interface LocaleState {
  locale: Locale;
  /** Switches the UI language: saves it in this browser and updates `<html lang>`. */
  setLocale: (locale: Locale) => void;
}

/** Keeps `<html lang>` in step with the UI language (screen readers, hyphenation, `:lang()`). */
export function applyHtmlLang(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
}

/** The UI language. Starts as English; `initLocale()` sets the detected one before the first render. */
export const useLocaleStore = create<LocaleState>()((set) => ({
  locale: DEFAULT_LOCALE,
  setLocale: (locale) => {
    writeStoredLocale(locale);
    applyHtmlLang(locale);
    set((s) => (s.locale === locale ? s : { locale }));
  },
}));

/** The current UI language, for plain modules (outside React). */
export function getLocale(): Locale {
  return useLocaleStore.getState().locale;
}

/**
 * Startup: applies `detectInitialLocale()` to the store and `<html lang>`. The detected value is not
 * written to storage, so a browser-language guess never pins itself as a choice.
 */
export function initLocale(): Locale {
  const locale = detectInitialLocale();
  applyHtmlLang(locale);
  useLocaleStore.setState({ locale });
  return locale;
}
