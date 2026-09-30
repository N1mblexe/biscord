import { describe, expect, it } from 'vitest';
import { en } from './messages/en';
import { tr } from './messages/tr';
import { isPluralForms } from './translate';
import type { MessageKey, MessagesOf } from './types';

/** Leaf path → the sorted `{param}` names it uses (a plural leaf: the union over its forms). */
function leaves(node: unknown, prefix = '', out = new Map<string, string[]>()): Map<string, string[]> {
  if (typeof node === 'string' || isPluralForms(node)) {
    const texts: string[] =
      typeof node === 'string'
        ? [node]
        : [node.zero, node.one, node.other].filter((v): v is string => typeof v === 'string');
    const params = new Set(
      texts.flatMap((text) => Array.from(text.matchAll(/\{(\w+)\}/g), (m) => m[1] ?? '')),
    );
    out.set(prefix, [...params].sort());
    return out;
  }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    leaves(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/** Leaf path → its plural forms (empty for a plain string). */
function pluralForms(node: unknown, prefix = '', out = new Map<string, string[]>()): Map<string, string[]> {
  if (typeof node === 'string') out.set(prefix, []);
  else if (isPluralForms(node)) out.set(prefix, Object.keys(node).sort());
  else
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      pluralForms(child, prefix ? `${prefix}.${key}` : key, out);
    }
  return out;
}

describe('en/tr parity', () => {
  it('has the same keys', () => {
    expect([...leaves(tr).keys()].sort()).toEqual([...leaves(en).keys()].sort());
  });

  it('uses the same {param} placeholders per key', () => {
    expect(Object.fromEntries(leaves(tr))).toEqual(Object.fromEntries(leaves(en)));
  });

  it('gives the same plural forms', () => {
    expect(Object.fromEntries(pluralForms(tr))).toEqual(Object.fromEntries(pluralForms(en)));
  });

  it('has no empty text', () => {
    for (const dictionary of [en, tr]) {
      const empty: string[] = [];
      JSON.stringify(dictionary, (key, value: unknown) => {
        if (value === '') empty.push(key);
        return value;
      });
      expect(empty).toEqual([]);
    }
  });
});

describe('translation types', () => {
  it('reject missing and extra keys at compile time', () => {
    const ok: MessagesOf<'common'>['language'] = { label: 'Dil', en: 'English', tr: 'Türkçe' };
    // @ts-expect-error -- a missing key
    const missing: MessagesOf<'common'>['language'] = { label: 'Dil', en: 'English' };
    const extra: MessagesOf<'common'>['language'] = {
      label: 'Dil',
      en: 'English',
      tr: 'Türkçe',
      // @ts-expect-error -- an extra key
      de: 'Deutsch',
    };
    // @ts-expect-error -- a plural entry keeps every English form
    const plural: MessagesOf<'common'>['memberCount'] = { other: '{count} üye' };
    const key: MessageKey = 'common.language.label';
    // @ts-expect-error -- a group is not a key
    const group: MessageKey = 'common.language';
    // @ts-expect-error -- a plural form is not a key
    const form: MessageKey = 'common.memberCount.one';
    expect([ok, missing, extra, plural, key, group, form]).toHaveLength(7);
  });
});
