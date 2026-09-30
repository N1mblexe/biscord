import { a11y } from './a11y';
import { admin } from './admin';
import { auth } from './auth';
import { chat } from './chat';
import { common } from './common';
import { errors } from './errors';
import { settings } from './settings';
import { voice } from './voice';

/** The English dictionary: the source of truth for every key (and the fallback for missing ones). */
export const en = { common, auth, settings, admin, chat, voice, errors, a11y } as const;

/**
 * A plural leaf: an object with an `other` form, plus `one` and optionally `zero`. `t()` picks the
 * form with `Intl.PluralRules(locale).select(params.count)` (`zero` wins for a count of 0 when present).
 */
export interface PluralForms {
  zero?: string;
  one: string;
  other: string;
}

/**
 * The widened shape of `T`: every string leaf becomes `string`, and a plural leaf keeps exactly its
 * English forms (so Turkish must give the same forms, with any text).
 */
export type Widen<T> = T extends string
  ? string
  : T extends { readonly other: string }
    ? { -readonly [K in keyof T]: string }
    : { -readonly [K in keyof T]: Widen<T[K]> };

/** The shape every language's dictionary must have: the same keys as English, any strings. */
export type Messages = Widen<typeof en>;

export type Namespace = keyof Messages;

/** One namespace's shape, for typing a translation file: `export const chat: MessagesOf<'chat'> = {…}`. */
export type MessagesOf<N extends Namespace> = Messages[N];
