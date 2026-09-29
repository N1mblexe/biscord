import type { Message } from '@hearth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageStore } from '../stores/messages';
import { setReaction } from './reactions';

const api = vi.hoisted(() => ({
  addReaction: vi.fn<(messageId: string, emoji: string) => Promise<void>>(),
  removeReaction: vi.fn<(messageId: string, emoji: string) => Promise<void>>(),
}));
vi.mock('../api/chat', () => api);

const CH = '11111111-1111-4111-8111-111111111111';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function msg(reactions: Message['reactions']): Message {
  return {
    id: '1',
    channelId: CH,
    authorId: ALICE,
    content: 'hi',
    createdAt: '2026-09-28T10:00:00.000Z',
    editedAt: null,
    attachments: [],
    reactions,
    mentionUserIds: [],
    nonce: null,
  };
}

const reactions = () => useMessageStore.getState().channels[CH]?.byId['1']?.reactions;

beforeEach(() => {
  api.addReaction.mockReset();
  api.removeReaction.mockReset();
  useMessageStore.getState().reset();
});

describe('setReaction', () => {
  it('applies at once and keeps the change when the request succeeds', async () => {
    useMessageStore.getState().loadLatest(CH, [msg([])], false);
    api.addReaction.mockResolvedValue(undefined);
    const request = setReaction(CH, '1', '👍', ME, true);
    expect(reactions()).toEqual([{ emoji: '👍', userIds: [ME] }]);
    await request;
    expect(api.addReaction).toHaveBeenCalledWith('1', '👍');
    expect(reactions()).toEqual([{ emoji: '👍', userIds: [ME] }]);
  });

  it('reverts its own optimistic change when the request fails', async () => {
    useMessageStore.getState().loadLatest(CH, [msg([])], false);
    api.addReaction.mockRejectedValue(new Error('offline'));
    await expect(setReaction(CH, '1', '👍', ME, true)).rejects.toThrow('offline');
    expect(reactions()).toEqual([]);
  });

  it('does not remove a reaction that already existed when an add fails', async () => {
    useMessageStore.getState().loadLatest(CH, [msg([{ emoji: '👍', userIds: [ALICE, ME] }])], false);
    api.addReaction.mockRejectedValue(new Error('offline'));
    await expect(setReaction(CH, '1', '👍', ME, true)).rejects.toThrow('offline');
    expect(reactions()).toEqual([{ emoji: '👍', userIds: [ALICE, ME] }]);
  });

  it('does not re-add a reaction that was already gone when a remove fails', async () => {
    useMessageStore.getState().loadLatest(CH, [msg([{ emoji: '👍', userIds: [ALICE] }])], false);
    api.removeReaction.mockRejectedValue(new Error('offline'));
    await expect(setReaction(CH, '1', '👍', ME, false)).rejects.toThrow('offline');
    expect(reactions()).toEqual([{ emoji: '👍', userIds: [ALICE] }]);
  });
});
