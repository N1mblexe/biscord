import type { Messages } from './messages/en';

export type { Messages, MessagesOf, Namespace, PluralForms } from './messages/en';

/** Dotted paths of every leaf under `T`; a plural object (`{ one, other }`) is one leaf. */
type LeafPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends { other: string }
      ? `${P}${K}`
      : LeafPaths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Dotted paths of the plural leaves under `T`. */
type PluralPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends { other: string }
      ? `${P}${K}`
      : PluralPaths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every translatable key, e.g. `'common.language.label'`. */
export type MessageKey = LeafPaths<Messages>;

/** The keys whose text depends on `params.count` (plural leaves). */
export type PluralKey = PluralPaths<Messages>;

/** Values for `{name}` placeholders; `count` also picks a plural form. */
export type Params = Record<string, string | number>;

/** A translate function bound to one locale (what `useT()` returns). */
export type TFunction = (key: MessageKey, params?: Params) => string;
