import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectionStatus } from './ConnectionStatus';
import { EmptyState } from './EmptyState';
import { ChannelListSkeleton, MessageListSkeleton } from './Skeleton';
import { inputClass, secondaryButton } from './styles';

/** The text content of the element carrying `data-testid="<id>"` (no nested elements expected). */
function testIdText(html: string, id: string): string | undefined {
  return new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];
}

describe('ConnectionStatus', () => {
  it('keeps the raw socket value in socket-status for the e2e suite', () => {
    const up = renderToStaticMarkup(createElement(ConnectionStatus, { status: 'connected' }));
    expect(testIdText(up, 'socket-status')).toBe('connected');
    expect(up).toContain('data-state="connected"');
    expect(up).toContain('Connected');

    const down = renderToStaticMarkup(createElement(ConnectionStatus, { status: 'disconnected' }));
    expect(testIdText(down, 'socket-status')).toBe('disconnected');
    // Never connected since the page loaded (and online): still connecting.
    expect(down).toContain('data-state="connecting"');
  });

  it('keeps a visible dot and hides only the label on phones', () => {
    const html = renderToStaticMarkup(createElement(ConnectionStatus, { status: 'connected' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('bg-success');
    expect(html).toContain('<span class="sr-only md:not-sr-only">Connected</span>');
  });
});

describe('Skeletons', () => {
  it('announce what is loading once', () => {
    const messages = renderToStaticMarkup(createElement(MessageListSkeleton));
    expect(messages).toContain('data-testid="messages-skeleton"');
    expect(messages.match(/role="status"/g)).toHaveLength(1);
    expect(messages).toContain('Loading messages…');

    const channels = renderToStaticMarkup(createElement(ChannelListSkeleton));
    expect(channels).toContain('data-testid="channels-skeleton"');
    expect(channels).toContain('Loading channels…');
  });
});

describe('EmptyState', () => {
  it('renders the title as a heading and the compact variant as plain text', () => {
    const full = renderToStaticMarkup(
      createElement(EmptyState, { icon: 'channels', title: 'Welcome to #general' }, 'Nothing here yet.'),
    );
    expect(full).toContain('data-testid="empty-state"');
    expect(full).toMatch(/<h2[^>]*>Welcome to #general<\/h2>/);

    const compact = renderToStaticMarkup(
      createElement(EmptyState, { icon: 'dm', title: 'No conversations yet', compact: true }, 'Start one.'),
    );
    expect(compact).not.toContain('<h2');
    expect(compact).toContain('No conversations yet');
  });
});

describe('style swaps', () => {
  // Composer and MembersPanel derive their classes with String.replace on these substrings; a
  // silent no-op would bring back the wrapped placeholder or the conflicting button padding.
  it('keeps the substrings that the composer and the members panel replace', () => {
    expect(inputClass).toContain('placeholder:text-muted');
    expect(secondaryButton).toContain('px-3 py-1.5 text-sm');
  });
});
