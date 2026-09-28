import type { Message } from '@hearth/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapQueryKey } from '../api/chat';
import { setSocketConnected } from '../lib/messageSync';
import { useMessageStore } from '../stores/messages';
import { registerChatEvents } from './chatEvents';
import type { HearthSocket } from './socket';

const CH = '11111111-1111-4111-8111-111111111111';
const AUTHOR = '33333333-3333-4333-8333-333333333333';

function msg(id: number, overrides: Partial<Message> = {}): Message {
  return {
    id: String(id),
    channelId: CH,
    authorId: AUTHOR,
    content: `m${id}`,
    createdAt: '2026-09-28T10:00:00.000Z',
    editedAt: null,
    attachments: [],
    reactions: [],
    mentionUserIds: [],
    nonce: null,
    ...overrides,
  };
}

type Listener = (...args: unknown[]) => void;

/** Just enough of a Socket.IO client for registerChatEvents: on/off, `connected` and a test-side emit. */
function fakeSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const fake = {
    connected: false,
    on(event: string, fn: Listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return fake;
    },
    off(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return fake;
    },
    /** Delivers a server event (or `connect` / `disconnect`) to the registered listeners. */
    fire(event: string, ...args: unknown[]) {
      if (event === 'connect') fake.connected = true;
      if (event === 'disconnect') fake.connected = false;
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
  return { fake, socket: fake as unknown as HearthSocket };
}

/** Every GET of CH's history returns messages 1..3 (filtered by `after`); records the URLs. */
function stubHistory() {
  const urls: URL[] = [];
  const all = [msg(1), msg(2), msg(3)];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input, 'http://localhost');
      urls.push(url);
      const after = url.searchParams.get('after');
      const messages = after === null ? all : all.filter((m) => Number(m.id) > Number(after));
      return Promise.resolve(new Response(JSON.stringify({ messages }), { status: 200 }));
    }),
  );
  return urls;
}

const store = () => useMessageStore.getState();

beforeEach(() => {
  store().reset();
  setSocketConnected(false);
  vi.stubGlobal('window', {
    location: { pathname: '/' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerChatEvents', () => {
  it('catches up and refetches bootstrap on the first connect too', async () => {
    // History was fetched before the socket joined its rooms: 1 and 2 are loaded, 3 was missed.
    store().loadLatest(CH, [msg(1), msg(2)], false);
    const urls = stubHistory();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const { fake, socket } = fakeSocket();
    const unregister = registerChatEvents(socket, { queryClient, navigate: vi.fn() });

    fake.fire('connect');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: bootstrapQueryKey });
    await vi.waitFor(() => {
      expect(store().channels[CH]?.ids).toEqual(['1', '2', '3']);
    });
    expect(urls.map((u) => u.searchParams.get('after'))).toEqual(['2']);

    // Now live: a created event advances the cursor; an update for an unknown id inserts nothing.
    fake.fire('message:created', { message: msg(4) });
    expect(store().channels[CH]?.syncedThrough).toBe('4');
    fake.fire('message:updated', { message: msg(99, { editedAt: '2026-09-28T10:05:00.000Z' }) });
    expect(store().channels[CH]?.ids).toEqual(['1', '2', '3', '4']);

    // After a disconnect the channel is no longer live, and the next connect catches up again.
    fake.fire('disconnect');
    fake.fire('connect');
    fake.fire('message:created', { message: msg(6) });
    expect(store().channels[CH]?.syncedThrough).toBe('4');
    await vi.waitFor(() => {
      expect(urls.map((u) => u.searchParams.get('after'))).toEqual(['2', '4']);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    unregister();
  });
});
