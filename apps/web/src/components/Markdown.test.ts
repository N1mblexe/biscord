import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const render = (source: string): string => renderToStaticMarkup(createElement(Markdown, null, source));

describe('Markdown', () => {
  it('renders bold, italics, strikethrough and code', () => {
    expect(render('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(render('*em* ~~gone~~ `x`')).toBe('<p><em>em</em> <del>gone</del> <code>x</code></p>');
  });

  it('shows raw inline HTML as literal, escaped text with no element', () => {
    const html = render('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows block and inline HTML inside text as literal text', () => {
    const html = render('<div onclick="x()">hi</div>\n\nsay <b>hi</b> <script>alert(1)</script>');
    expect(html).not.toMatch(/<(div|b|script)[\s>]/);
    expect(html).toContain('&lt;div onclick=&quot;x()&quot;&gt;hi&lt;/div&gt;');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('never produces a javascript: href', () => {
    const html = render('[x](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
    expect(html).toContain('x');
  });

  it('opens safe links in a new tab without an opener', () => {
    expect(render('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p>',
    );
  });

  it('unwraps headings, images and tables', () => {
    const heading = render('# Title');
    expect(heading).not.toContain('<h1');
    expect(heading).toContain('Title');

    const image = render('![alt](https://example.com/a.png)');
    expect(image).not.toContain('<img');

    const table = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table).not.toMatch(/<(table|tr|td|th)[\s>]/);
    expect(table).toContain('1');
  });

  it('keeps lists, quotes and code blocks', () => {
    expect(render('- one\n- two')).toContain('<ul>');
    expect(render('> quoted')).toContain('<blockquote>');
    expect(render('```\ncode\n```')).toContain('<pre><code>code\n</code></pre>');
  });
});
