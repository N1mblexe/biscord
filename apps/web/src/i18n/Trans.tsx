import type { Locale } from '@hearth/shared';
import { Fragment, type ReactNode } from 'react';
import { useLocaleStore } from './store';
import { interpolate, template } from './translate';
import type { MessageKey, Params } from './types';

/** Renders the text between `<tag>` and `</tag>`; the key is the tag name. */
export type TransComponents = Readonly<Record<string, (children: ReactNode) => ReactNode>>;

const TAG = /<(\w+)>([\s\S]*?)<\/\1>/g;

/**
 * Builds React nodes from a translated template: each `<tag>…</tag>` (one level, no nesting) goes
 * through `components[tag]`, and `{name}` placeholders are filled per text segment. Tags are parsed
 * before interpolation, so markup-like text in a param (a display name) stays plain text. A tag with
 * no component renders just its content.
 */
export function renderRich(text: string, params?: Params, components: TransComponents = {}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    const [whole, tag = '', inner = ''] = match;
    if (match.index > last) nodes.push(interpolate(text.slice(last, match.index), params));
    const content = interpolate(inner, params);
    const render = Object.hasOwn(components, tag) ? components[tag] : undefined;
    nodes.push(<Fragment key={nodes.length}>{render ? render(content) : content}</Fragment>);
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(interpolate(text.slice(last), params));
  return nodes;
}

export interface TransProps {
  k: MessageKey;
  params?: Params;
  components?: TransComponents;
  /** Overrides the current UI language (tests, previews). */
  locale?: Locale;
}

/**
 * A translated sentence with markup, e.g. `'Have an invite? <link>Register</link>'` with
 * `components={{ link: (c) => <Link to="/register">{c}</Link> }}`. Never uses `dangerouslySetInnerHTML`.
 */
export function Trans({ k, params, components, locale }: TransProps) {
  const current = useLocaleStore((s) => s.locale);
  return <>{renderRich(template(locale ?? current, k, params), params, components)}</>;
}
