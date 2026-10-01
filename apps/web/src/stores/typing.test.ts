import { LIMITS } from '@hearth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocaleStore } from '../i18n/store';
import { typingText, useTypingStore } from './typing';

const CH = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const store = () => useTypingStore.getState();
const typing = (channelId = CH) => store().byChannel[channelId] ?? [];

beforeEach(() => {
  vi.useFakeTimers();
  store().reset();
});

afterEach(() => {
  store().reset();
  vi.useRealTimers();
});

describe('typing store', () => {
  it('shows a user until the expiry after their last typing event', () => {
    store().start(CH, ALICE);
    expect(typing()).toEqual([ALICE]);
    vi.advanceTimersByTime(LIMITS.typingExpiryMs - 1);
    expect(typing()).toEqual([ALICE]);
    vi.advanceTimersByTime(1);
    expect(typing()).toEqual([]);
  });

  it('restarts the expiry on every event', () => {
    store().start(CH, ALICE);
    vi.advanceTimersByTime(4000);
    store().start(CH, ALICE);
    vi.advanceTimersByTime(4000);
    expect(typing()).toEqual([ALICE]);
    vi.advanceTimersByTime(1000);
    expect(typing()).toEqual([]);
  });

  it('stop (a message from that user) clears at once, and the old timer does nothing later', () => {
    store().start(CH, ALICE);
    store().start(CH, BOB);
    store().stop(CH, ALICE);
    expect(typing()).toEqual([BOB]);
    store().start(CH, ALICE);
    vi.advanceTimersByTime(LIMITS.typingExpiryMs - 1);
    expect(typing()).toEqual([BOB, ALICE]);
  });

  it('keeps channels apart and clears one channel', () => {
    store().start(CH, ALICE);
    store().start(OTHER, BOB);
    store().clearChannel(CH);
    expect(typing()).toEqual([]);
    expect(typing(OTHER)).toEqual([BOB]);
  });

  it('reset cancels every timer', () => {
    store().start(CH, ALICE);
    store().reset();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('typingText', () => {
  it('matches the UI contract', () => {
    expect(typingText([])).toBeNull();
    expect(typingText(['Alice'])).toBe('Alice is typing…');
    expect(typingText(['Alice', 'Bob'])).toBe('Alice and Bob are typing…');
    expect(typingText(['Alice', 'Bob', 'Carol'])).toBe('Several people are typing…');
  });

  it('uses Turkish grammar in Turkish', () => {
    useLocaleStore.setState({ locale: 'tr' });
    try {
      expect(typingText(['Ayşe'])).toBe('Ayşe yazıyor…');
      expect(typingText(['Ayşe', 'Mehmet'])).toBe('Ayşe ve Mehmet yazıyor…');
      expect(typingText(['Ayşe', 'Mehmet', 'Can'])).toBe('Birkaç kişi yazıyor…');
    } finally {
      useLocaleStore.setState({ locale: 'en' });
    }
  });
});
