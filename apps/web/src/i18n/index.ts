/**
 * Web i18n (CONTRACTS B.11): typed dictionaries, `t()` and `Intl`, no library.
 *
 * - `messages/en/<namespace>.ts` is the source of truth (`as const`); `messages/tr/<namespace>.ts` is
 *   typed `MessagesOf<'<namespace>'>`, so a missing or extra key is a type error.
 * - A leaf is a string with `{name}` placeholders, or a plural object `{ one, other }` (optionally
 *   `zero`) chosen by `params.count`. Keys are dotted paths: `t('common.language.label')`.
 * - Components use `useT()` / `<Trans>`; plain modules use `t()` (current language, no re-render).
 * - Dates, numbers, sizes, sorting and upper-casing go through `format.ts`.
 * - Not translated: message content, usernames, display names, channel names, emoji, codes, filenames.
 */
export { en } from './messages/en';
export { tr } from './messages/tr';
export type {
  Messages,
  MessagesOf,
  MessageKey,
  Namespace,
  Params,
  PluralForms,
  PluralKey,
  TFunction,
} from './types';
export { useLocaleStore, getLocale, initLocale, applyHtmlLang, type LocaleState } from './store';
export {
  LANGUAGE_STORAGE_KEY,
  browserLocale,
  detectInitialLocale,
  isLocale,
  readStoredLocale,
  writeStoredLocale,
} from './detect';
export { dictionaries, interpolate, t, template, tFor } from './translate';
export { useLocale, useT } from './useT';
export { renderRich, Trans, type TransComponents, type TransProps } from './Trans';
export {
  compare,
  dayLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  upper,
  type DateInput,
} from './format';
