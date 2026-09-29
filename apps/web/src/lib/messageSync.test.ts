import type { Message } from '@hearth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageStore } from '../stores/messages';
import {
  CATCH_UP_PAGE,
  catchUpAll,
  deliverPending,
  HISTORY_PAGE,
  loadLatest,
  loadOlder,
  receiveCreated,
  receiveUpdated,
  setSocketConnected,
} from './messageSync';

const CH = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
const AUTHOR = '33333333-3333-4333-8333-333333333333';

function msg(id: number, channelId = CH): Message {
  return {
    id: String(id),
    channelId,
    authorId: AUTHOR,
    content: `m${id}`,
    createdAt: '2026-09-28T10:00:00.000Z',
    editedAt: null,
    attachments: [],
    reactions: [],
    mentionUserIds: [],
    nonce: null,
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

/**
 * A fake server holding messages 1..total of CH (`all` is live: push to add more); GONE answers 404.
 * A POST sends the next message id. Records every GET URL.
 */
function fakeServer(total: number, all = range(1, total)) {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      if (init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('expected a JSON body');
        const body = JSON.parse(init.body) as { content: string; nonce: string };
        const sent = { ...msg(all.length + 1), content: body.content, nonce: body.nonce };
        all.push(sent);
        return Promise.resolve(new Response(JSON.stringify({ message: sent }), { status: 201 }));
      }
      urls.push(url);
      if (url.pathname.includes(GONE)) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone' } }), { status: 404 }),
        );
      }
      const limit = Number(url.searchParams.get('limit'));
      const before = url.searchParams.get('before');
      const after = url.searchParams.get('after');
      let page: Message[];
      if (after) page = all.filter((m) => Number(m.id) > Number(after)).slice(0, limit);
      else if (before) page = all.filter((m) => Number(m.id) < Number(before)).slice(-limit);
      else page = all.slice(-limit);
      return Promise.resolve(new Response(JSON.stringify({ messages: page }), { status: 200 }));
    }),
  );
  return urls;
}

const store = () => useMessageStore.getState();

beforeEach(() => {
  store().reset();
  setSocketConnected(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message sync', () => {
  it('loads the latest page, then older pages until the start', async () => {
    fakeServer(120);
    await loadLatest(CH);
    expect(store().channels[CH]?.ids).toEqual(range(71, 120).map((m) => m.id));
    expect(store().channels[CH]?.hasOlder).toBe(true);

    await Promise.all([loadOlder(CH), loadOlder(CH)]); // shared request
    expect(store().channels[CH]?.ids.length).toBe(100);
    await loadOlder(CH);
    const ids = store().channels[CH]?.ids ?? [];
    expect(ids).toEqual(range(1, 120).map((m) => m.id));
    expect(store().channels[CH]?.hasOlder).toBe(false);
    expect(HISTORY_PAGE).toBe(50);
  });

  it('catches up after a reconnect by paging ?after= until a short page', async () => {
    const urls = fakeServer(10);
    await loadLatest(CH);
    // 105 new messages arrived while offline.
    const catchUpUrls = fakeServer(10 + CATCH_UP_PAGE + 5);
    await catchUpAll();
    expect(urls).toHaveLength(1);
    expect(catchUpUrls.map((u) => u.searchParams.get('after'))).toEqual(['10', String(10 + CATCH_UP_PAGE)]);
    expect(catchUpUrls.every((u) => u.searchParams.get('limit') === String(CATCH_UP_PAGE))).toBe(true);
    const ids = store().channels[CH]?.ids ?? [];
    expect(ids).toEqual(range(1, 115).map((m) => m.id));
  });

  it('forgets channels that are gone', async () => {
    store().loadLatest(GONE, [msg(1, GONE)], false);
    const urls = fakeServer(3);
    await catchUpAll();
    expect(urls).toHaveLength(1);
    expect(store().channels[GONE]).toBeUndefined();
  });

  it('sends the attachment ids of a pending message and keeps them for a retry', async () => {
    const attachment = {
      id: '6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a',
      filename: 'cat.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      url: '/api/attachments/6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a/cat.png',
      inline: true,
    };
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init?: RequestInit) => {
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), {
            status: 429,
          }),
        );
      }),
    );
    store().addPending({
      nonce: 'n1',
      channelId: CH,
      authorId: AUTHOR,
      content: '',
      attachments: [attachment],
      createdAt: 'x',
    });
    await expect(deliverPending('n1')).rejects.toThrow('slow down');
    expect(bodies).toEqual([{ content: '', nonce: 'n1', attachmentIds: [attachment.id] }]);
    expect(store().pending.n1?.status).toBe('failed');
    expect(store().pending.n1?.attachments).toEqual([attachment]);
  });

  it('pages from syncedThrough, not from our own newer message sent over REST', async () => {
    const all = range(1, 10);
    fakeServer(10, all);
    await loadLatest(CH);
    expect(store().channels[CH]?.syncedThrough).toBe('10');

    // While the socket is down, others send 11 and 12, then our own send gets 13 over REST.
    all.push(msg(11), msg(12));
    const urls = fakeServer(0, all);
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'mine', createdAt: 'x' });
    await deliverPending('n1');
    expect(store().channels[CH]?.ids.at(-1)).toBe('13');
    expect(store().channels[CH]?.syncedThrough).toBe('10');

    await catchUpAll();
    expect(urls.map((u) => u.searchParams.get('after'))).toEqual(['10']);
    expect(store().channels[CH]?.ids).toEqual(range(1, 13).map((m) => m.id));
    expect(store().channels[CH]?.syncedThrough).toBe('13');
  });

  it('lets live events advance syncedThrough only once the channel is synced in this connection', async () => {
    const all = range(1, 10);
    fakeServer(10, all);
    setSocketConnected(true);
    await loadLatest(CH); // loaded while connected: live
    receiveCreated(msg(11));
    all.push(msg(11));
    expect(store().channels[CH]?.syncedThrough).toBe('11');

    // Disconnect; 12 and 13 are missed. After reconnecting, 14 arrives before catch-up finished.
    setSocketConnected(false);
    all.push(msg(12), msg(13), msg(14));
    setSocketConnected(true);
    receiveCreated(msg(14));
    expect(store().channels[CH]?.syncedThrough).toBe('11');

    const urls = fakeServer(0, all);
    await catchUpAll();
    expect(urls.map((u) => u.searchParams.get('after'))).toEqual(['11']);
    expect(store().channels[CH]?.ids).toEqual(range(1, 14).map((m) => m.id));
    receiveCreated(msg(15)); // live again after the catch-up
    expect(store().channels[CH]?.syncedThrough).toBe('15');
  });

  it('message:updated never inserts, message:created ignores channels not opened', () => {
    store().loadLatest(CH, range(71, 120), true);
    receiveUpdated({ ...msg(5), content: 'edited', editedAt: '2026-09-28T10:05:00.000Z' });
    expect(store().channels[CH]?.ids[0]).toBe('71');
    receiveCreated(msg(1, GONE));
    expect(store().channels[GONE]).toBeUndefined();
  });

  it('loads channels whose first load failed during catch-up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await expect(loadLatest(CH)).rejects.toThrow();
    expect(store().channels[CH]?.loaded).toBe(false);

    const urls = fakeServer(3);
    setSocketConnected(true);
    await catchUpAll();
    expect(store().channels[CH]).toMatchObject({ loaded: true, ids: ['1', '2', '3'], syncedThrough: '3' });
    expect(urls[0]?.searchParams.get('after')).toBeNull();
  });
});
