import type { VoiceParticipant } from '@hearth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useVoiceStore } from './voice';

const LOUNGE = '11111111-1111-4111-8111-111111111111';
const GAMES = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function p(userId: string, second: number, overrides: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    userId,
    joinedAt: `2026-09-29T10:00:${String(second).padStart(2, '0')}.000Z`,
    selfMute: false,
    selfDeaf: false,
    camera: false,
    screen: false,
    ...overrides,
  };
}

const store = () => useVoiceStore.getState();
const ids = (channelId: string) => (store().byChannel[channelId] ?? []).map((x) => x.userId);

beforeEach(() => {
  store().reset();
});

describe('voice participants store', () => {
  it('seeds from a bootstrap snapshot, ordered by join time', () => {
    store().applySnapshot({ [LOUNGE]: [p(B, 2), p(A, 1)], [GAMES]: [] }, store().seq);
    expect(ids(LOUNGE)).toEqual([A, B]);
    expect(store().byChannel[GAMES]).toBeUndefined();
  });

  it('applies joined, updated and left', () => {
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(A, 1) });
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(B, 2) });
    store().apply({ type: 'updated', channelId: LOUNGE, participant: p(A, 1, { selfMute: true }) });
    expect(ids(LOUNGE)).toEqual([A, B]);
    expect(store().byChannel[LOUNGE]?.[0]?.selfMute).toBe(true);
    store().apply({ type: 'left', channelId: LOUNGE, userId: A });
    expect(ids(LOUNGE)).toEqual([B]);
    store().apply({ type: 'left', channelId: LOUNGE, userId: A }); // idempotent
    expect(ids(LOUNGE)).toEqual([B]);
  });

  it('lists a user in one channel only: a join elsewhere moves them, the late left is a no-op', () => {
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(A, 1) });
    store().apply({ type: 'joined', channelId: GAMES, participant: p(A, 5) });
    expect(ids(LOUNGE)).toEqual([]);
    expect(ids(GAMES)).toEqual([A]);
    store().apply({ type: 'left', channelId: LOUNGE, userId: A });
    expect(ids(GAMES)).toEqual([A]);
  });

  it('replays events that arrived while the snapshot was in flight, in order', () => {
    store().applySnapshot({ [LOUNGE]: [p(A, 1)] }, store().seq);
    const mark = store().seq;
    // During the request: A moves to Games (joined, then the old room's left), C joins Lounge, and
    // B joins then leaves Lounge.
    store().apply({ type: 'joined', channelId: GAMES, participant: p(A, 5) });
    store().apply({ type: 'left', channelId: LOUNGE, userId: A });
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(C, 6) });
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(B, 7) });
    store().apply({ type: 'left', channelId: LOUNGE, userId: B });
    // The (older) snapshot still has A in Lounge and B in Lounge, and no C.
    store().applySnapshot({ [LOUNGE]: [p(A, 1), p(B, 3)] }, mark);
    expect(ids(LOUNGE)).toEqual([C]);
    expect(ids(GAMES)).toEqual([A]);
  });

  it('a snapshot overrides events from before its request', () => {
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(A, 1) });
    const mark = store().seq;
    store().applySnapshot({ [GAMES]: [p(B, 2, { selfDeaf: true, selfMute: true })] }, mark);
    expect(ids(LOUNGE)).toEqual([]);
    expect(store().byChannel[GAMES]).toEqual([p(B, 2, { selfDeaf: true, selfMute: true })]);
  });

  it('forgets a deleted channel', () => {
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(A, 1) });
    store().forgetChannel(LOUNGE);
    expect(store().byChannel).toEqual({});
  });

  it('reset clears everything', () => {
    store().apply({ type: 'joined', channelId: LOUNGE, participant: p(A, 1) });
    store().reset();
    expect(store().byChannel).toEqual({});
    expect(store().seq).toBe(0);
    expect(store().lastEvent).toEqual({});
  });
});
