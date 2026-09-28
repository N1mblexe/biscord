import { describe, expect, it } from 'vitest';
import { eventChannelId } from './eventLog';

describe('eventChannelId', () => {
  it('finds the channel of each payload shape', () => {
    expect(eventChannelId({ channelId: 'c1', messageId: '1' })).toBe('c1');
    expect(eventChannelId({ message: { channelId: 'c2' } })).toBe('c2');
    expect(eventChannelId({ channel: { id: 'c3', type: 'dm' } })).toBe('c3');
    expect(eventChannelId({ channels: [] })).toBeNull();
    expect(eventChannelId({ user: { id: 'u' } })).toBeNull();
    expect(eventChannelId(undefined)).toBeNull();
  });
});
