import type { Locale } from '@hearth/shared';
import { useCallback } from 'react';
import { useLocaleStore } from './store';
import { tFor } from './translate';
import type { TFunction } from './types';

/** `t` bound to the current UI language; the component re-renders when the language changes. */
export function useT(): TFunction {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback<TFunction>((key, params) => tFor(locale, key, params), [locale]);
}

/** The current UI language and its setter (which saves it in this browser and updates `<html lang>`). */
export function useLocale(): [Locale, (locale: Locale) => void] {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  return [locale, setLocale];
}
