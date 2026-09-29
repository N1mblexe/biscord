import type { Message } from '@hearth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyReactionChange, compareMessageIds, useMessageStore } from './messages';

const CH = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AUTHOR = '33333333-3333-4333-8333-333333333333';

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: CH,
    authorId: AUTHOR,
    content: `message ${id}`,
    createdAt: '2026-09-28T10:00:00.000Z',
    editedAt: null,
    attachments: [],
    reactions: [],
    mentionUserIds: [],
    nonce: null,
    ...overrides,
  };
}

const store = () => useMessageStore.getState();
const channel = (id = CH) => store().channels[id];

beforeEach(() => {
  store().reset();
});

describe('compareMessageIds', () => {
  it('orders bigint strings numerically', () => {
    expect(['10', '9', '100', '2', '11'].sort(compareMessageIds)).toEqual(['2', '9', '10', '11', '100']);
    expect(compareMessageIds('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
  });
});

describe('message store', () => {
  it('keeps ids sorted numerically across upserts', () => {
    store().upsertMany(CH, [msg('10'), msg('9')]);
    store().upsertMany(CH, [msg('100'), msg('2')]);
    store().upsert(msg('50'));
    expect(channel()?.ids).toEqual(['2', '9', '10', '50', '100']);
  });

  it('dedupes by id and replaces content in place', () => {
    store().loadLatest(CH, [msg('1'), msg('2')], false);
    store().upsertMany(CH, [msg('2'), msg('1')]);
    store().upsert(msg('2', { content: 'edited', editedAt: '2026-09-28T10:05:00.000Z' }));
    expect(channel()?.ids).toEqual(['1', '2']);
    expect(channel()?.byId['2']?.content).toBe('edited');
  });

  it('does not let a stale copy overwrite a newer edit', () => {
    store().upsert(msg('1', { content: 'v2', editedAt: '2026-09-28T10:05:00.000Z' }));
    store().upsert(msg('1'));
    store().upsert(msg('1', { content: 'v1', editedAt: '2026-09-28T10:01:00.000Z' }));
    expect(channel()?.byId['1']?.content).toBe('v2');
  });

  it('is a no-op (same state object) for an identical upsert', () => {
    const m = msg('1');
    store().upsert(m);
    const before = store().channels;
    store().upsert(m);
    expect(store().channels).toBe(before);
  });

  it('marks a channel loaded with hasOlder from loadLatest, buffering earlier events', () => {
    store().ensureChannel(CH);
    expect(channel()?.loaded).toBe(false);
    store().upsert(msg('60')); // live event while the first page is in flight
    store().loadLatest(CH, [msg('58'), msg('59'), msg('60')], true);
    expect(channel()).toMatchObject({ ids: ['58', '59', '60'], loaded: true, hasOlder: true });
    store().setHasOlder(CH, false);
    expect(channel()?.hasOlder).toBe(false);
  });

  it('replaces the pending copy when the message with its nonce arrives', () => {
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'hi', createdAt: 'x' });
    expect(store().pending.n1?.status).toBe('sending');
    store().upsert(msg('5', { nonce: 'n1', content: 'hi' }));
    expect(store().pending).toEqual({});
    expect(channel()?.ids).toEqual(['5']);
  });

  it('handles message:created arriving before the REST response', () => {
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'hi', createdAt: 'x' });
    const real = msg('7', { nonce: 'n1' });
    store().upsert(real); // socket event
    store().resolvePending('n1', real); // REST response
    expect(channel()?.ids).toEqual(['7']);
    expect(store().pending).toEqual({});
  });

  it('handles the REST response arriving before message:created', () => {
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'hi', createdAt: 'x' });
    const real = msg('7', { nonce: 'n1' });
    store().resolvePending('n1', real);
    store().upsert(real);
    expect(channel()?.ids).toEqual(['7']);
    expect(store().pending).toEqual({});
  });

  it('resolves a pending send even if the server did not echo the nonce', () => {
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'hi', createdAt: 'x' });
    store().resolvePending('n1', msg('8'));
    expect(store().pending).toEqual({});
    expect(channel()?.ids).toEqual(['8']);
  });

  it('marks failed, retries and discards pending sends', () => {
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'hi', createdAt: 'x' });
    store().failPending('n1');
    expect(store().pending.n1?.status).toBe('failed');
    store().retryPending('n1');
    expect(store().pending.n1?.status).toBe('sending');
    store().discardPending('n1');
    expect(store().pending).toEqual({});
    store().failPending('missing'); // unknown nonce: no-op
    expect(store().pending).toEqual({});
  });

  it('removes a message and never resurrects it from a stale page or late event', () => {
    store().loadLatest(CH, [msg('1'), msg('2'), msg('3')], false);
    store().remove(CH, '2');
    expect(channel()?.ids).toEqual(['1', '3']);
    expect(channel()?.byId['2']).toBeUndefined();
    store().upsertMany(CH, [msg('1'), msg('2'), msg('3')]);
    expect(channel()?.ids).toEqual(['1', '3']);
    store().remove(CH, '2'); // idempotent
    expect(channel()?.ids).toEqual(['1', '3']);
  });

  it('keeps channels separate and forgets one with its pending sends', () => {
    store().upsert(msg('1'));
    store().upsert(msg('2', { channelId: OTHER }));
    store().addPending({ nonce: 'n1', channelId: OTHER, authorId: AUTHOR, content: 'x', createdAt: 'x' });
    expect(channel(OTHER)?.ids).toEqual(['2']);
    store().forgetChannel(OTHER);
    expect(channel(OTHER)).toBeUndefined();
    expect(store().pending).toEqual({});
    expect(channel()?.ids).toEqual(['1']);
  });

  it('reset clears everything', () => {
    store().upsert(msg('1'));
    store().remove(CH, '1');
    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'x', createdAt: 'x' });
    store().reset();
    expect(store().channels).toEqual({});
    expect(store().pending).toEqual({});
    expect(store().tombstones).toEqual({});
  });

  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => msg(String(from + i)));
  const EDITED = '2026-09-28T10:05:00.000Z';

  it('updateIfPresent never inserts an unknown id (no hole in paged history)', () => {
    store().loadLatest(CH, range(71, 120), true);
    store().updateIfPresent(msg('5', { content: 'edited', editedAt: EDITED }));
    expect(channel()?.ids).toEqual(range(71, 120).map((m) => m.id));
    expect(channel()?.byId['5']).toBeUndefined();

    store().updateIfPresent(msg('80', { content: 'edited', editedAt: EDITED }));
    expect(channel()?.byId['80']?.content).toBe('edited');
    expect(channel()?.ids).toHaveLength(50);

    store().updateIfPresent(msg('1', { channelId: OTHER, editedAt: EDITED })); // unknown channel
    expect(channel(OTHER)).toBeUndefined();
  });

  it('inserts a new message unless it would punch a hole below the oldest loaded id', () => {
    store().loadLatest(CH, range(71, 120), true);
    store().upsert(msg('121'));
    expect(channel()?.ids.at(-1)).toBe('121');
    store().upsert(msg('60')); // older than ids[0] while there is unloaded history
    expect(channel()?.ids[0]).toBe('71');
    expect(channel()?.byId['60']).toBeUndefined();

    // Fully loaded (nothing older on the server): any id is safe to insert.
    store().loadLatest(OTHER, [msg('10', { channelId: OTHER })], false);
    store().upsert(msg('9', { channelId: OTHER }));
    store().upsert(msg('11', { channelId: OTHER }));
    expect(channel(OTHER)?.ids).toEqual(['9', '10', '11']);
  });

  it('a latest page with history behind it drops older loaded ids', () => {
    store().ensureChannel(CH);
    store().upsert(msg('5')); // buffered before the first page
    store().upsert(msg('121')); // arrived during the fetch
    store().loadLatest(CH, range(71, 120), true);
    expect(channel()?.ids).toEqual([...range(71, 120).map((m) => m.id), '121']);
    expect(channel()?.byId['5']).toBeUndefined();
  });

  it('advances syncedThrough from the latest page and advanceSynced, never from our own send', () => {
    store().ensureChannel(CH);
    expect(channel()?.syncedThrough).toBeNull();
    store().loadLatest(CH, range(1, 10), false);
    expect(channel()?.syncedThrough).toBe('10');

    store().addPending({ nonce: 'n1', channelId: CH, authorId: AUTHOR, content: 'hi', createdAt: 'x' });
    store().resolvePending('n1', msg('13', { nonce: 'n1' }));
    expect(channel()?.ids.at(-1)).toBe('13');
    expect(channel()?.syncedThrough).toBe('10');

    store().advanceSynced(CH, '12');
    store().advanceSynced(CH, '11'); // never backwards
    expect(channel()?.syncedThrough).toBe('12');
    store().setLiveEpoch(CH, 3);
    expect(channel()?.liveEpoch).toBe(3);
  });
});

describe('reactions', () => {
  const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const YOU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('applyReactionChange adds, removes and keeps server order', () => {
    let reactions = applyReactionChange([], '👍', ME, true);
    expect(reactions).toEqual([{ emoji: '👍', userIds: [ME] }]);
    reactions = applyReactionChange(reactions, '🔥', YOU, true);
    reactions = applyReactionChange(reactions, '👍', YOU, true);
    expect(reactions).toEqual([
      { emoji: '👍', userIds: [ME, YOU] },
      { emoji: '🔥', userIds: [YOU] },
    ]);
    reactions = applyReactionChange(reactions, '👍', ME, false);
    expect(reactions).toEqual([
      { emoji: '👍', userIds: [YOU] },
      { emoji: '🔥', userIds: [YOU] },
    ]);
    reactions = applyReactionChange(reactions, '👍', YOU, false);
    expect(reactions).toEqual([{ emoji: '🔥', userIds: [YOU] }]);
  });

  it('applyReactionChange is idempotent (same array when nothing changes)', () => {
    const reactions = [{ emoji: '👍', userIds: [ME] }];
    expect(applyReactionChange(reactions, '👍', ME, true)).toBe(reactions);
    expect(applyReactionChange(reactions, '👍', YOU, false)).toBe(reactions);
    expect(applyReactionChange(reactions, '🔥', ME, false)).toBe(reactions);
  });

  it('applyReaction updates a loaded message and ignores unknown ones', () => {
    store().loadLatest(CH, [msg('1')], false);
    // Optimistic toggle, then the matching event: applied once.
    expect(store().applyReaction(CH, '1', '👍', ME, true)).toBe(true);
    expect(store().applyReaction(CH, '1', '👍', ME, true)).toBe(false);
    expect(channel()?.byId['1']?.reactions).toEqual([{ emoji: '👍', userIds: [ME] }]);
    expect(store().applyReaction(CH, '1', '👍', ME, false)).toBe(true);
    expect(channel()?.byId['1']?.reactions).toEqual([]);
    const before = store().channels;
    expect(store().applyReaction(CH, '2', '👍', ME, true)).toBe(false);
    expect(store().applyReaction(OTHER, '1', '👍', ME, true)).toBe(false);
    expect(store().channels).toBe(before);
  });
});
