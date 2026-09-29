import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import {
  applyUserVolume,
  DEFAULT_VOLUME,
  readVolumes,
  useVolumeStore,
  VOLUME_STORAGE_KEY,
  volumeFor,
} from './volume';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  useVolumeStore.getState().reload();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('per-user volume', () => {
  it('defaults to full volume', () => {
    expect(volumeFor(A)).toBe(DEFAULT_VOLUME);
  });

  it('saves by user id and survives a reload', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    useVolumeStore.getState().setVolume(A, 0.35);
    useVolumeStore.getState().setVolume(B, 0);
    expect(JSON.parse(storage.data.get(VOLUME_STORAGE_KEY) ?? '{}')).toEqual({ [A]: 0.35, [B]: 0 });

    useVolumeStore.setState({ volumes: {} });
    useVolumeStore.getState().reload();
    expect(volumeFor(A)).toBe(0.35);
    expect(volumeFor(B)).toBe(0);
  });

  it('clamps to 0–1 and forgets a volume set back to the default', () => {
    expect(useVolumeStore.getState().setVolume(A, 1.7)).toBe(1);
    expect(useVolumeStore.getState().setVolume(A, -2)).toBe(0);
    useVolumeStore.getState().setVolume(A, 1);
    expect(readVolumes()).toEqual({});
  });

  it('ignores malformed storage', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [VOLUME_STORAGE_KEY]: '{"x": "loud", "y": 0.5' }));
    expect(readVolumes()).toEqual({});
    vi.stubGlobal('localStorage', memoryStorage({ [VOLUME_STORAGE_KEY]: `{"${A}": "loud", "${B}": 0.5}` }));
    expect(readVolumes()).toEqual({ [B]: 0.5 });
  });

  it('works without storage (blocked): the volume applies for this page only', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    useVolumeStore.getState().reload();
    expect(useVolumeStore.getState().setVolume(A, 0.5)).toBe(0.5);
    expect(volumeFor(A)).toBe(0.5);
  });
});

describe('applyUserVolume', () => {
  it("sets the user's microphone and screen-share audio to the slider value", () => {
    const calls: [number, Track.Source | undefined][] = [];
    applyUserVolume(
      {
        setVolume: (volume, source) => {
          calls.push([volume, source]);
        },
      },
      0.4,
    );
    expect(calls).toEqual([
      [0.4, Track.Source.Microphone],
      [0.4, Track.Source.ScreenShareAudio],
    ]);
  });
});
