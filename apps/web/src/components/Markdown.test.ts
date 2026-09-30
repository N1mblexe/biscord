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
    expect(image).toContain('alt');

    const table = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table).not.toMatch(/<(table|tr|td|th)[\s>]/);
    expect(table).toContain('1');
  });

  it('keeps lists, quotes and code blocks', () => {
    expect(render('- one\n- two')).toContain('<ul>');
    expect(render('> quoted')).toContain('<blockquote>');
    expect(render('```\ncode\n```')).toContain('<pre><code>code\n</code></pre>');
  });

  it('shows an image as a link with its alt text (never an <img>)', () => {
    expect(render('see ![a cat](https://example.com/cat.png)')).toBe(
      '<p>see <a href="https://example.com/cat.png" target="_blank" rel="noopener noreferrer">a cat</a></p>',
    );
    expect(render('![](https://example.com/cat.png)')).toContain('>https://example.com/cat.png</a>');
  });

  it('shows the alt text alone for unsafe, relative or nested images', () => {
    expect(render('![evil](javascript:alert(1))')).toBe('<p>evil</p>');
    expect(render('![rel](/uploads/x.png)')).toBe('<p>rel</p>');
    expect(render('![ref][r]\n\n[r]: https://example.com/x.png')).toBe('<p>ref</p>');
    const nested = render('[![logo](https://example.com/l.png)](https://example.com)');
    expect(nested).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">logo</a></p>',
    );
  });

  it('shows task-list items with their state as text', () => {
    const html = render('- [x] done\n- [ ] todo');
    expect(html).not.toContain('<input');
    expect(html).toContain('<li>☑ done</li>');
    expect(html).toContain('<li>☐ todo</li>');
  });
});
