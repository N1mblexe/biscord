import type { BootstrapResponse, Message } from '@hearth/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapQueryKey } from '../api/chat';
import { setSocketConnected } from '../lib/messageSync';
import { useMessageStore } from '../stores/messages';
import { usePresenceStore } from '../stores/presence';
import { unreadSummary, useReadsStore } from '../stores/reads';
import { useTypingStore } from '../stores/typing';
import { useViewingStore } from '../stores/viewing';
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
  usePresenceStore.getState().reset();
  useReadsStore.getState().reset();
  useTypingStore.getState().reset();
  useViewingStore.setState({ channelId: null, atBottom: false });
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

describe('registerChatEvents (phase 4 events)', () => {
  const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const person = (id: string, displayName: string) => ({
    id,
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    role: 'member' as const,
    deactivated: false,
  });
  const boot: BootstrapResponse = {
    me: { ...person(ME, 'Bob'), createdAt: '2026-09-28T10:00:00.000Z' },
    users: [person(ME, 'Bob'), person(AUTHOR, 'Alice')],
    channels: [{ id: CH, type: 'text', name: 'general', position: 0 }],
    dms: [],
    readStates: [{ channelId: CH, lastReadMessageId: '0', unread: false, mentionCount: 0 }],
    voice: {},
    onlineUserIds: [],
    livekitUrl: 'ws://localhost:7880',
  };

  function setup(visibility: DocumentVisibilityState) {
    const shown: { title: string; body: string | undefined }[] = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        shown.push({ title, body: options?.body });
      }
      close() {
        return undefined;
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('window', {
      location: { pathname: '/' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      Notification: FakeNotification,
    });
    vi.stubGlobal('document', { visibilityState: visibility });
    vi.stubGlobal('localStorage', { getItem: () => 'on' });
    const queryClient = new QueryClient();
    queryClient.setQueryData(bootstrapQueryKey, boot);
    useReadsStore.getState().applySnapshot(boot.readStates);
    const { fake, socket } = fakeSocket();
    const unregister = registerChatEvents(socket, { queryClient, navigate: vi.fn() });
    return { fake, shown, unregister };
  }

  const summary = () => unreadSummary(useReadsStore.getState().channels[CH]);

  it('wires typing, presence, read states and reactions to their stores', () => {
    const { fake, unregister } = setup('visible');
    fake.fire('typing', { channelId: CH, userId: AUTHOR });
    fake.fire('typing', { channelId: CH, userId: ME }); // my own other tab: ignored
    expect(useTypingStore.getState().byChannel[CH]).toEqual([AUTHOR]);
    fake.fire('message:created', { message: msg(1) });
    expect(useTypingStore.getState().byChannel[CH]).toEqual([]);

    fake.fire('presence', { userId: AUTHOR, online: true });
    expect(usePresenceStore.getState().online[AUTHOR]).toBe(true);

    expect(summary()).toEqual({ unread: true, mentionCount: 0 });
    fake.fire('readstate:updated', {
      readState: { channelId: CH, lastReadMessageId: '1', unread: false, mentionCount: 0 },
    });
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });

    store().loadLatest(CH, [msg(1)], false);
    fake.fire('reaction:added', { channelId: CH, messageId: '1', emoji: '👍', userId: AUTHOR });
    expect(store().channels[CH]?.byId['1']?.reactions).toEqual([{ emoji: '👍', userIds: [AUTHOR] }]);
    fake.fire('reaction:removed', { channelId: CH, messageId: '1', emoji: '👍', userId: AUTHOR });
    expect(store().channels[CH]?.byId['1']?.reactions).toEqual([]);
    unregister();
  });

  it('does not mark the channel being read (at the bottom, visible) as unread', () => {
    const { fake, unregister } = setup('visible');
    useViewingStore.getState().setViewing(CH, true);
    fake.fire('message:created', { message: msg(1) });
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });
    // Same channel, but the tab is hidden: unread.
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    fake.fire('message:created', { message: msg(2, { mentionUserIds: [ME] }) });
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
    unregister();
  });

  it('notifies a mention while hidden, not a plain message or my own', () => {
    const { fake, shown, unregister } = setup('hidden');
    fake.fire('message:created', { message: msg(1, { content: '**@bob** look', mentionUserIds: [ME] }) });
    fake.fire('message:created', { message: msg(2, { content: 'plain' }) });
    fake.fire('message:created', { message: msg(3, { authorId: ME, mentionUserIds: [ME] }) });
    expect(shown).toEqual([{ title: 'Alice in #general', body: '@bob look' }]);
    unregister();
  });
});
