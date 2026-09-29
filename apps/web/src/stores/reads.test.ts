import type { Message, ReadState } from '@hearth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { unreadSummary, useReadsStore } from './reads';

const CH = '11111111-1111-4111-8111-111111111111';
const OTHER_CH = '22222222-2222-4222-8222-222222222222';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: CH,
    authorId: ALICE,
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

function rs(lastReadMessageId: string, unread = false, mentionCount = 0, channelId = CH): ReadState {
  return { channelId, lastReadMessageId, unread, mentionCount };
}

const store = () => useReadsStore.getState();
const summary = (channelId = CH) => unreadSummary(store().channels[channelId]);

beforeEach(() => {
  store().reset();
});

describe('reads store', () => {
  it('seeds from bootstrap', () => {
    store().applySnapshot([rs('5', true, 2), rs('0', false, 0, OTHER_CH)]);
    expect(summary()).toEqual({ unread: true, mentionCount: 2 });
    expect(summary(OTHER_CH)).toEqual({ unread: false, mentionCount: 0 });
    expect(summary('unknown')).toEqual({ unread: false, mentionCount: 0 });
  });

  it('infers unread and mentions from live messages by others', () => {
    store().applySnapshot([rs('5')]);
    store().receiveMessage(msg('6'), ME);
    expect(summary()).toEqual({ unread: true, mentionCount: 0 });
    store().receiveMessage(msg('7', { mentionUserIds: [ME] }), ME);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('counts a duplicate event once and ignores already-read and own messages', () => {
    store().applySnapshot([rs('5')]);
    store().receiveMessage(msg('6', { mentionUserIds: [ME] }), ME);
    store().receiveMessage(msg('6', { mentionUserIds: [ME] }), ME);
    store().receiveMessage(msg('4', { mentionUserIds: [ME] }), ME);
    store().receiveMessage(msg('8', { authorId: ME }), ME);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('infers for a channel with no read state yet (e.g. a new DM)', () => {
    store().receiveMessage(msg('1', { mentionUserIds: [ME] }), ME);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('adds live mentions on top of the server count', () => {
    store().applySnapshot([rs('5', true, 2)]);
    store().receiveMessage(msg('9', { mentionUserIds: [ME] }), ME);
    expect(summary()).toEqual({ unread: true, mentionCount: 3 });
  });

  it('an authoritative state overrides the guesses it has read', () => {
    store().applySnapshot([rs('5')]);
    store().receiveMessage(msg('6'), ME);
    store().receiveMessage(msg('7', { mentionUserIds: [ME] }), ME);
    store().applyServer(rs('7', false, 0));
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });
    expect(store().channels[CH]?.seen).toEqual({});
  });

  it('an authoritative state counts the guesses it has not read yet (no double count)', () => {
    store().applySnapshot([rs('5')]);
    store().receiveMessage(msg('6'), ME);
    store().receiveMessage(msg('7', { mentionUserIds: [ME] }), ME);
    // Read through 6; the server already counts 7's mention.
    store().applyServer(rs('6', true, 1));
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
    // Even if it raced 7 and says "read", the unread message keeps the channel unread.
    store().applyServer(rs('6', false, 0));
    expect(summary()).toEqual({ unread: true, mentionCount: 0 });
  });

  it('ignores a stale (older) server state but accepts an equal one', () => {
    store().applyServer(rs('10', false, 0));
    store().applyServer(rs('8', true, 3));
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });
    store().applyServer(rs('10', true, 1));
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('a snapshot keeps newer guesses and newer server states', () => {
    store().applyServer(rs('10'));
    store().receiveMessage(msg('11'), ME);
    store().applySnapshot([rs('10', false, 0), rs('3', true, 1, OTHER_CH)]);
    expect(summary()).toEqual({ unread: true, mentionCount: 0 });
    expect(summary(OTHER_CH)).toEqual({ unread: true, mentionCount: 1 });
  });

  it('a snapshot requested before a mention and applied after it keeps the mention counted', () => {
    store().applySnapshot([rs('5')]);
    const sinceSeq = store().seq; // bootstrap requested here
    store().receiveMessage(msg('6', { mentionUserIds: [ME] }), ME); // M arrives while it is in flight
    // The server computed the snapshot before M existed.
    store().applySnapshot([rs('5', false, 0)], sinceSeq);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
    expect(store().channels[CH]?.seen['6']?.counted).toBe(false);
    // A later authoritative state that includes M counts it exactly once.
    store().applyServer(rs('5', true, 1));
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('a snapshot requested after a mention counts it (no double count)', () => {
    store().applySnapshot([rs('5')]);
    store().receiveMessage(msg('6', { mentionUserIds: [ME] }), ME);
    const sinceSeq = store().seq; // bootstrap requested after M arrived: its counts include M
    store().applySnapshot([rs('5', true, 1)], sinceSeq);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
    expect(store().channels[CH]?.seen['6']?.counted).toBe(true);
  });

  it('a POST response requested before a mention keeps it counted', () => {
    store().applySnapshot([rs('5')]);
    const sinceSeq = store().seq;
    store().receiveMessage(msg('7', { mentionUserIds: [ME] }), ME);
    store().applyServer(rs('6', false, 0), sinceSeq);
    expect(summary()).toEqual({ unread: true, mentionCount: 1 });
  });

  it('a deleted guessed message no longer counts', () => {
    store().applySnapshot([rs('5')]);
    store().receiveMessage(msg('6', { mentionUserIds: [ME] }), ME);
    store().removeMessage(CH, '6');
    expect(summary()).toEqual({ unread: false, mentionCount: 0 });
  });

  it('keeps state identity when nothing changes', () => {
    store().applySnapshot([rs('5', true, 1)]);
    const before = store().channels;
    store().applyServer(rs('5', true, 1));
    store().applySnapshot([rs('5', true, 1)]);
    expect(store().channels).toBe(before);
  });

  it('forgets a channel and resets', () => {
    store().applySnapshot([rs('5', true, 1), rs('1', true, 0, OTHER_CH)]);
    store().forgetChannel(CH);
    expect(store().channels[CH]).toBeUndefined();
    store().reset();
    expect(store().channels).toEqual({});
  });
});
