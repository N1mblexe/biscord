import { DEFAULT_LOCALE, type Locale } from '@hearth/shared';
import { en } from './messages/en';
import { tr } from './messages/tr';
import { getLocale } from './store';
import type { MessageKey, Messages, Params, PluralForms } from './types';

export const dictionaries: Readonly<Record<Locale, Messages>> = { en, tr };

type Leaf = string | PluralForms;

export function isPluralForms(value: unknown): value is PluralForms {
  return (
    typeof value === 'object' && value !== null && typeof (value as { other?: unknown }).other === 'string'
  );
}

function lookup(dictionary: Messages, key: string): Leaf | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' || isPluralForms(node) ? node : undefined;
}

const warned = new Set<string>();

function warnMissing(locale: Locale, key: string): void {
  if (!import.meta.env.DEV) return;
  const id = `${locale}:${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[i18n] missing "${key}" in "${locale}"`);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralRulesFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

/**
 * The form for `count`: `zero` for 0 when the entry has one, otherwise the category from
 * `Intl.PluralRules(locale)`, falling back to `other` (also when `count` is missing or not a number).
 */
function pluralForm(locale: Locale, forms: PluralForms, count: string | number | undefined): string {
  const n =
    typeof count === 'number' ? count : count !== undefined && count.trim() !== '' ? Number(count) : NaN;
  if (!Number.isFinite(n)) return forms.other;
  if (n === 0 && forms.zero !== undefined) return forms.zero;
  const category = pluralRulesFor(locale).select(n);
  return (forms as unknown as Partial<Record<Intl.LDMLPluralRule, string>>)[category] ?? forms.other;
}

/** Replaces each `{name}` with `params.name`; a placeholder without a param is left as it is. */
export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/**
 * The raw text for `key` in `locale`, before interpolation (plural form already chosen). A key missing
 * in a translation falls back to English; a key missing everywhere returns the key itself.
 */
export function template(locale: Locale, key: MessageKey, params?: Params): string {
  let source = locale;
  let leaf = lookup(dictionaries[locale], key);
  if (leaf === undefined && locale !== DEFAULT_LOCALE) {
    warnMissing(locale, key);
    source = DEFAULT_LOCALE;
    leaf = lookup(dictionaries[DEFAULT_LOCALE], key);
  }
  if (leaf === undefined) {
    warnMissing(DEFAULT_LOCALE, key);
    return key;
  }
  return typeof leaf === 'string' ? leaf : pluralForm(source, leaf, params?.count);
}

/** The text for `key` in `locale`, with `{name}` placeholders filled from `params`. */
export function tFor(locale: Locale, key: MessageKey, params?: Params): string {
  return interpolate(template(locale, key, params), params);
}

/**
 * The text for `key` in the current UI language. Works outside React (stores, plain modules); a
 * component should use `useT()` so it re-renders when the language changes.
 */
export function t(key: MessageKey, params?: Params): string {
  return tFor(getLocale(), key, params);
}
