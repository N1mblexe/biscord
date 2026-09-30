import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderRich, Trans, type TransComponents } from './Trans';
import { dictionaries } from './translate';
import type { MessageKey } from './types';

type Writable = Record<string, unknown>;

const components: TransComponents = {
  link: (children: ReactNode) => createElement('a', { href: '/register' }, children),
  b: (children: ReactNode) => createElement('b', null, children),
};

function html(node: ReactNode): string {
  return renderToStaticMarkup(createElement('p', null, node));
}

// Test-only entries (the real sentences arrive with the page namespaces).
beforeAll(() => {
  (dictionaries.en.common as unknown as Writable).transTest = 'Have an invite? <link>Register</link>';
  (dictionaries.tr.common as unknown as Writable).transTest = 'Davetin mi var? <link>Kaydol</link>';
  (dictionaries.en.common as unknown as Writable).confirmTest = 'Type <b>{name}</b> to confirm.';
});

afterAll(() => {
  delete (dictionaries.en.common as unknown as Writable).transTest;
  delete (dictionaries.tr.common as unknown as Writable).transTest;
  delete (dictionaries.en.common as unknown as Writable).confirmTest;
});

describe('Trans', () => {
  it('renders tags through components', () => {
    const markup = renderToStaticMarkup(
      createElement(Trans, { k: 'common.transTest' as MessageKey, components }),
    );
    expect(markup).toBe('Have an invite? <a href="/register">Register</a>');
  });

  it('uses the locale prop', () => {
    const markup = renderToStaticMarkup(
      createElement(Trans, { k: 'common.transTest' as MessageKey, components, locale: 'tr' }),
    );
    expect(markup).toBe('Davetin mi var? <a href="/register">Kaydol</a>');
  });

  it('interpolates inside tags, and markup in a param stays text', () => {
    const markup = renderToStaticMarkup(
      createElement(Trans, {
        k: 'common.confirmTest' as MessageKey,
        params: { name: '<b>general</b>' },
        components,
      }),
    );
    expect(markup).toBe('Type <b>&lt;b&gt;general&lt;/b&gt;</b> to confirm.');
  });

  it('renders plain text without components', () => {
    expect(renderToStaticMarkup(createElement(Trans, { k: 'common.loading' }))).toBe('Loading…');
  });
});

describe('renderRich', () => {
  it('renders an unknown tag as its content and keeps text around several tags', () => {
    expect(html(renderRich('a <x>b</x> c <b>d</b>!', undefined, components))).toBe('<p>a b c <b>d</b>!</p>');
    expect(html(renderRich('no tags {n}', { n: 2 }))).toBe('<p>no tags 2</p>');
  });
});
