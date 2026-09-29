import type { ReadState } from '@hearth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadsStore } from '../stores/reads';
import { MARK_READ_DEBOUNCE_MS, scheduleMarkRead } from './readMarking';

const markRead = vi.hoisted(() => vi.fn<(channelId: string, messageId: string) => Promise<ReadState>>());
vi.mock('../api/chat', () => ({ markRead }));

const CH = '11111111-1111-4111-8111-111111111111';
const state = (lastReadMessageId: string): ReadState => ({
  channelId: CH,
  lastReadMessageId,
  unread: false,
  mentionCount: 0,
});

beforeEach(() => {
  vi.useFakeTimers();
  markRead.mockReset();
  useReadsStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleMarkRead', () => {
  it('debounces, then applies the response', async () => {
    markRead.mockResolvedValue(state('7'));
    scheduleMarkRead(CH, '7');
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS - 1);
    expect(markRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(markRead).toHaveBeenCalledWith(CH, '7');
    expect(useReadsStore.getState().channels[CH]?.server.lastReadMessageId).toBe('7');
  });

  it('retries a failed POST after 1 s and 3 s, then gives up', async () => {
    markRead.mockRejectedValue(new Error('offline'));
    scheduleMarkRead(CH, '7');
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS);
    expect(markRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(markRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(markRead).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(markRead).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(markRead).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(markRead).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once a retry succeeds', async () => {
    markRead.mockRejectedValueOnce(new Error('500')).mockResolvedValue(state('7'));
    scheduleMarkRead(CH, '7');
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS + 1_000);
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(useReadsStore.getState().channels[CH]?.server.lastReadMessageId).toBe('7');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('cancelling stops the debounce and pending retries', async () => {
    const cancelEarly = scheduleMarkRead(CH, '7');
    cancelEarly();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(markRead).not.toHaveBeenCalled();

    markRead.mockRejectedValue(new Error('offline'));
    const cancel = scheduleMarkRead(CH, '7');
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS);
    expect(markRead).toHaveBeenCalledTimes(1);
    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});
