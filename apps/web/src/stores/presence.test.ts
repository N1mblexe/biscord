import { beforeEach, describe, expect, it } from 'vitest';
import { usePresenceStore } from './presence';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const store = () => usePresenceStore.getState();
const onlineIds = () => Object.keys(store().online).sort();

beforeEach(() => {
  store().reset();
});

describe('presence store', () => {
  it('seeds from a bootstrap snapshot', () => {
    store().applySnapshot([A, B], store().seq);
    expect(onlineIds()).toEqual([A, B]);
  });

  it('applies presence events', () => {
    store().applySnapshot([A], store().seq);
    store().setOnline(B, true);
    store().setOnline(A, false);
    expect(onlineIds()).toEqual([B]);
    store().setOnline(B, true); // idempotent
    expect(onlineIds()).toEqual([B]);
  });

  it('replays events that arrived while the snapshot was in flight', () => {
    store().applySnapshot([A], store().seq);
    const mark = store().seq;
    // During the request: A goes offline, C comes online.
    store().setOnline(A, false);
    store().setOnline(C, true);
    // The (older) snapshot still says A online, C offline, and adds B.
    store().applySnapshot([A, B], mark);
    expect(onlineIds()).toEqual([B, C]);
  });

  it('a snapshot overrides events from before its request', () => {
    store().setOnline(A, true);
    const mark = store().seq;
    store().applySnapshot([B], mark);
    expect(onlineIds()).toEqual([B]);
  });

  it('reset clears everything', () => {
    store().setOnline(A, true);
    store().reset();
    expect(onlineIds()).toEqual([]);
    expect(store().seq).toBe(0);
  });
});
