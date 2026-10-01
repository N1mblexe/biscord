import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_QUALITY,
  DEFAULT_VOICE_PREFS,
  followVoicePrefsStorage,
  parseVoicePrefs,
  readVoicePrefs,
  useVoicePrefs,
  VOICE_PREFS_KEY,
  writeVoicePrefs,
} from './prefs';

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

const blocked = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
  removeItem: () => undefined,
};

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  useVoicePrefs.getState().reload();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voice prefs (CONTRACTS B.12 rule 1)', () => {
  it('defaults keep today’s behaviour: default devices, processing on, always transmit, 720p', () => {
    expect(DEFAULT_VOICE_PREFS).toEqual({
      audioInputId: 'default',
      audioOutputId: 'default',
      videoInputId: 'default',
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      inputMode: 'voice',
      vadGate: false,
      vadThresholdDb: -50,
      pttKey: { type: 'key', code: 'Backquote' },
      pttReleaseMs: 200,
      muteKey: null,
      deafenKey: null,
      cameraQuality: '720p',
    });
    expect(CAMERA_QUALITY).toEqual({
      '360p': { width: 640, height: 360, frameRate: 30 },
      '720p': { width: 1280, height: 720, frameRate: 30 },
      '1080p': { width: 1920, height: 1080, frameRate: 30 },
    });
  });

  it.each([[undefined], [null], ['nope'], [42], [[1, 2]]])(
    'anything not an object parses to the defaults (%j)',
    (raw) => {
      expect(parseVoicePrefs(raw)).toEqual(DEFAULT_VOICE_PREFS);
    },
  );

  it('keeps valid fields and falls back per field', () => {
    const prefs = parseVoicePrefs({
      audioInputId: 'mic-2',
      audioOutputId: '', // empty → default
      videoInputId: 7, // wrong type → default
      noiseSuppression: false,
      echoCancellation: 'yes', // → default
      inputMode: 'ptt',
      vadGate: true,
      pttKey: { type: 'mouse', button: 4 },
      muteKey: { type: 'key', code: 'KeyM' },
      deafenKey: { type: 'mouse', button: 2 }, // only 3/4 → default (null)
      cameraQuality: '4k', // → default
      extra: 'ignored',
    });
    expect(prefs).toEqual({
      ...DEFAULT_VOICE_PREFS,
      audioInputId: 'mic-2',
      noiseSuppression: false,
      inputMode: 'ptt',
      vadGate: true,
      pttKey: { type: 'mouse', button: 4 },
      muteKey: { type: 'key', code: 'KeyM' },
    });
    expect(prefs).not.toHaveProperty('extra');
  });

  it('clamps the numeric ranges instead of rejecting them', () => {
    expect(parseVoicePrefs({ vadThresholdDb: -250, pttReleaseMs: -5 })).toMatchObject({
      vadThresholdDb: -100,
      pttReleaseMs: 0,
    });
    expect(parseVoicePrefs({ vadThresholdDb: 12, pttReleaseMs: 5000 })).toMatchObject({
      vadThresholdDb: 0,
      pttReleaseMs: 1000,
    });
    expect(parseVoicePrefs({ pttReleaseMs: 123.6 }).pttReleaseMs).toBe(124);
    expect(parseVoicePrefs({ vadThresholdDb: Number.NaN }).vadThresholdDb).toBe(-50);
  });

  it('reads and writes localStorage, surviving bad JSON', () => {
    const storage = memoryStorage({ [VOICE_PREFS_KEY]: '{not json' });
    vi.stubGlobal('localStorage', storage);
    expect(readVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS);
    writeVoicePrefs({ ...DEFAULT_VOICE_PREFS, cameraQuality: '1080p' });
    expect(JSON.parse(storage.data.get(VOICE_PREFS_KEY) ?? '{}')).toMatchObject({ cameraQuality: '1080p' });
    expect(readVoicePrefs().cameraQuality).toBe('1080p');
  });

  it('blocked storage never throws: defaults, and saves are dropped', () => {
    vi.stubGlobal('localStorage', blocked);
    expect(readVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS);
    expect(() => {
      writeVoicePrefs(DEFAULT_VOICE_PREFS);
    }).not.toThrow();
    useVoicePrefs.getState().reload();
    useVoicePrefs.getState().update({ inputMode: 'ptt' });
    expect(useVoicePrefs.getState().prefs.inputMode).toBe('ptt');
  });

  it('no storage API at all gives the defaults', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS);
  });

  it('update validates (bad fields keep their value), clamps, saves and notifies', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const seen: string[] = [];
    const unsubscribe = useVoicePrefs.subscribe((s) => {
      seen.push(s.prefs.inputMode);
    });
    useVoicePrefs.getState().update({ inputMode: 'ptt', pttReleaseMs: 9999 });
    useVoicePrefs.getState().update({ cameraQuality: 'huge' as unknown as '720p', audioInputId: 'mic-9' });
    unsubscribe();
    const { prefs } = useVoicePrefs.getState();
    expect(prefs).toMatchObject({
      inputMode: 'ptt',
      pttReleaseMs: 1000,
      cameraQuality: '720p',
      audioInputId: 'mic-9',
    });
    expect(seen).toEqual(['ptt', 'ptt']);
    expect(JSON.parse(storage.data.get(VOICE_PREFS_KEY) ?? '{}')).toEqual(prefs);
  });

  it('an update that changes nothing does not notify', () => {
    const listener = vi.fn();
    const unsubscribe = useVoicePrefs.subscribe(listener);
    useVoicePrefs.getState().update({ inputMode: 'voice', pttKey: { type: 'key', code: 'Backquote' } });
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset goes back to the defaults (saved); reload re-reads storage', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    useVoicePrefs.getState().update({ vadGate: true, muteKey: { type: 'key', code: 'F13' } });
    useVoicePrefs.getState().reset();
    expect(useVoicePrefs.getState().prefs).toEqual(DEFAULT_VOICE_PREFS);
    expect(JSON.parse(storage.data.get(VOICE_PREFS_KEY) ?? '{}')).toEqual(DEFAULT_VOICE_PREFS);

    storage.data.set(VOICE_PREFS_KEY, JSON.stringify({ inputMode: 'ptt' }));
    useVoicePrefs.getState().reload();
    expect(useVoicePrefs.getState().prefs).toEqual({ ...DEFAULT_VOICE_PREFS, inputMode: 'ptt' });
  });
});

describe('followVoicePrefsStorage (another tab changed the prefs)', () => {
  it('reloads on a storage event for our key or a clear, ignores other keys, and unbinds', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const target = new EventTarget();
    const fire = (key: string | null) => {
      target.dispatchEvent(Object.assign(new Event('storage'), { key }));
    };
    const stop = followVoicePrefsStorage(target);

    storage.data.set(VOICE_PREFS_KEY, JSON.stringify({ inputMode: 'ptt' }));
    fire('something-else');
    expect(useVoicePrefs.getState().prefs.inputMode).toBe('voice');
    fire(VOICE_PREFS_KEY);
    expect(useVoicePrefs.getState().prefs.inputMode).toBe('ptt');

    storage.data.clear();
    fire(null);
    expect(useVoicePrefs.getState().prefs).toEqual(DEFAULT_VOICE_PREFS);

    stop();
    storage.data.set(VOICE_PREFS_KEY, JSON.stringify({ inputMode: 'ptt' }));
    fire(VOICE_PREFS_KEY);
    expect(useVoicePrefs.getState().prefs.inputMode).toBe('voice');
  });
});
