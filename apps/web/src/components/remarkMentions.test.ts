import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import { MENTION_PATTERN } from './remarkMentions';

/** Active users as the page passes them (bootstrap users, lowercased; deactivated `carol` left out). */
const USERNAMES: ReadonlySet<string> = new Set(['bob', 'alice', 'alice_1']);

const render = (source: string, selfUsername = 'bob', usernames = USERNAMES): string =>
  renderToStaticMarkup(createElement(Markdown, { selfUsername, usernames, children: source }));

const self = (text: string) => `<span class="mention" data-testid="mention" data-self="true">${text}</span>`;
const other = (text: string) =>
  `<span class="mention" data-testid="mention" data-self="false">${text}</span>`;

describe('mention highlighting', () => {
  it('marks a mention of me as self and others as not', () => {
    expect(render('@bob look at @alice_1')).toBe(`<p>${self('@bob')} look at ${other('@alice_1')}</p>`);
  });

  it('matches case-insensitively', () => {
    expect(render('hey @BoB!')).toBe(`<p>hey ${self('@BoB')}!</p>`);
  });

  it('works inside emphasis, lists and quotes', () => {
    expect(render('**@bob**')).toBe(`<p><strong>${self('@bob')}</strong></p>`);
    expect(render('- @alice')).toContain(`<li>${other('@alice')}</li>`);
    expect(render('> @bob')).toContain(self('@bob'));
  });

  it('leaves inline code and code blocks untouched', () => {
    expect(render('`@bob`')).toBe('<p><code>@bob</code></p>');
    expect(render('```\n@bob\n```')).toBe('<pre><code>@bob\n</code></pre>');
  });

  it('does not match email-like text, double @ or too-short names', () => {
    const html = render('mail bob@example.com or a@bob, @@bob, @bo');
    expect(html).not.toContain('data-testid="mention"');
  });

  it('keeps raw HTML literal while highlighting a mention next to it', () => {
    const html = render('<b>@bob</b>');
    expect(html).not.toContain('<b>');
    expect(html).toContain(`&lt;b&gt;${self('@bob')}&lt;/b&gt;`);
  });

  it('marks nobody as self without a username', () => {
    expect(renderToStaticMarkup(createElement(Markdown, { usernames: USERNAMES, children: '@bob' }))).toBe(
      `<p>${other('@bob')}</p>`,
    );
  });

  it('only wraps usernames of known active users', () => {
    // `carol` is deactivated (not in the set), `nobody` is unknown: plain text, like the server.
    expect(render('@carol and @nobody, but @alice')).toBe(
      `<p>@carol and @nobody, but ${other('@alice')}</p>`,
    );
    expect(render('@nobody')).toBe('<p>@nobody</p>');
  });

  it('wraps nothing without a username list', () => {
    expect(renderToStaticMarkup(createElement(Markdown, { selfUsername: 'bob', children: '@bob' }))).toBe(
      '<p>@bob</p>',
    );
  });

  it('uses the server pattern', () => {
    const names = (text: string) => Array.from(text.matchAll(MENTION_PATTERN), (m) => m[1]);
    expect(names('@abc @a_b_c1 x@nope @@nope @ab')).toEqual(['abc', 'a_b_c1']);
    expect(names(`@${'x'.repeat(40)}`)).toEqual(['x'.repeat(32)]);
  });
});
