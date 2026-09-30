import type { Message, ReadState } from '@hearth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { unreadSummary, useReadsStore } from './reads';

// CONTRACTS B.9 rule 6: after a delete (or a mention edit) the server sends each affected user a fresh
// `readstate:updated`. The client applies it as authoritative, so the badge follows it.

const CH = '11111111-1111-4111-8111-111111111111';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const rs = (lastReadMessageId: string, unread: boolean, mentionCount: number): ReadState => ({
  channelId: CH,
  lastReadMessageId,
  unread,
  mentionCount,
});

const msg = (id: string, mentionUserIds: string[] = []): Message => ({
  id,
  channelId: CH,
  authorId: ALICE,
  content: `message ${id}`,
  createdAt: '2026-09-30T10:00:00.000Z',
  editedAt: null,
  attachments: [],
  reactions: [],
  mentionUserIds,
  nonce: null,
});

const store = () => useReadsStore.getState();
const summary = () => unreadSummary(store().channels[CH]);

beforeEach(() => {
  store().reset();
});

describe('server read state after a delete or edit', () => {
  it('a deleted unread mention known only from bootstrap: the server state clears the badge', () => {
    // Bootstrap already counted the mention; there is no live "seen" entry the delete could drop.
    store().applySnapshot([rs('5', true, 1)]);
    store().removeMessage(CH, '6');
    expect(summary()).toEqual({ unread: true, mentionCount: 1 }); // the stuck badge, without the server
    store().applyServer(rs('5', false, 0));
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });
  });

  it('a deleted DM message seen live: message:deleted then the server state leave nothing behind', () => {
    store().applySnapshot([rs('5', false, 0)]);
    store().receiveMessage(msg('6', [ME]), ME);
    // An earlier server state already counted it (e.g. a bootstrap refetch).
    store().applyServer(rs('5', true, 1));
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
    store().removeMessage(CH, '6');
    store().applyServer(rs('5', false, 0));
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });
  });

  it('an edit that drops my mention lowers the count; other unread messages stay unread', () => {
    store().applySnapshot([rs('5', true, 2)]);
    store().applyServer(rs('5', true, 1));
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('a mention removed from a live-seen message stops counting once the server state arrives', () => {
    store().applySnapshot([rs('5', false, 0)]);
    store().receiveMessage(msg('6', [ME]), ME);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
    store().applyServer(rs('5', true, 0));
    expect(summary()).toEqual({ unread: true, mentionCount: 0 });
  });
});
