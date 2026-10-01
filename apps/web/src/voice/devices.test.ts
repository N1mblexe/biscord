import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audioConstraints,
  canPromptOutput,
  canSelectOutput,
  isMissingDevice,
  listDevices,
  micDeviceConstraint,
  openMic,
  resolveDevice,
  videoConstraints,
  withDefaultMic,
  type DeviceOption,
} from './devices';
import { DEFAULT_VOICE_PREFS } from './prefs';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mics: DeviceOption[] = [
  { deviceId: 'default', label: 'Default - Headset' },
  { deviceId: 'mic-1', label: 'Headset' },
  { deviceId: 'mic-2', label: 'Webcam mic' },
];

describe('resolveDevice', () => {
  it('keeps a preferred device that is present', () => {
    expect(resolveDevice(mics, 'mic-2')).toBe('mic-2');
  });

  it('falls back to default when the preferred device is missing (unplugged)', () => {
    expect(resolveDevice(mics, 'mic-gone')).toBe('default');
  });

  it('default stays default', () => {
    expect(resolveDevice(mics, 'default')).toBe('default');
    expect(resolveDevice([], 'default')).toBe('default');
  });

  it('an empty list (no permission yet) can’t tell, so the preference is kept', () => {
    expect(resolveDevice([], 'mic-2')).toBe('mic-2');
  });
});

describe('constraints', () => {
  it('audio: a chosen mic exact (Chromium ignores an ideal one), the default ideal, plus the processing flags', () => {
    expect(audioConstraints(DEFAULT_VOICE_PREFS)).toEqual({
      deviceId: { ideal: 'default' },
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    });
    const prefs = {
      ...DEFAULT_VOICE_PREFS,
      audioInputId: 'mic-1',
      noiseSuppression: false,
      autoGainControl: false,
    };
    expect(audioConstraints(prefs)).toMatchObject({
      deviceId: { exact: 'mic-1' },
      noiseSuppression: false,
      echoCancellation: true,
      autoGainControl: false,
    });
    expect(audioConstraints(prefs, 'default').deviceId).toEqual({ ideal: 'default' });
    expect(micDeviceConstraint('mic-2')).toEqual({ exact: 'mic-2' });
    expect(withDefaultMic(audioConstraints(prefs))).toEqual({
      ...audioConstraints(prefs),
      deviceId: { ideal: 'default' },
    });
  });

  it('isMissingDevice: only a device that is not there', () => {
    expect(isMissingDevice(Object.assign(new Error('x'), { name: 'OverconstrainedError' }))).toBe(true);
    expect(isMissingDevice(new DOMException('gone', 'NotFoundError'))).toBe(true);
    expect(isMissingDevice(new DOMException('denied', 'NotAllowedError'))).toBe(false);
    expect(isMissingDevice(new DOMException('busy', 'NotReadableError'))).toBe(false);
    expect(isMissingDevice('OverconstrainedError')).toBe(false);
    expect(isMissingDevice(null)).toBe(false);
  });

  it('openMic falls back to the default mic only when the chosen one is gone', async () => {
    const calls: unknown[] = [];
    const fail = (name: string) => {
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: (c: { audio: MediaTrackConstraints }) => {
            calls.push(c.audio.deviceId);
            if (calls.length === 1) return Promise.reject(new DOMException('x', name));
            return Promise.resolve('stream' as unknown as MediaStream);
          },
        },
      });
    };
    fail('OverconstrainedError');
    await expect(openMic({ deviceId: { exact: 'mic-1' } })).resolves.toBe('stream');
    expect(calls).toEqual([{ exact: 'mic-1' }, { ideal: 'default' }]);

    calls.length = 0;
    fail('NotAllowedError');
    await expect(openMic({ deviceId: { exact: 'mic-1' } })).rejects.toThrow();
    expect(calls).toEqual([{ exact: 'mic-1' }]);
  });

  it.each([
    ['360p', 640, 360],
    ['720p', 1280, 720],
    ['1080p', 1920, 1080],
  ] as const)('video %s', (cameraQuality, width, height) => {
    expect(videoConstraints({ ...DEFAULT_VOICE_PREFS, cameraQuality, videoInputId: 'cam-1' })).toEqual({
      deviceId: { ideal: 'cam-1' },
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30 },
      aspectRatio: { ideal: width / height },
    });
  });
});

describe('listDevices', () => {
  const info = (kind: MediaDeviceKind, deviceId: string, label: string) => ({
    kind,
    deviceId,
    label,
    groupId: 'g',
  });

  it('groups by kind and drops duplicates', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: () =>
          Promise.resolve([
            info('audioinput', 'default', 'Default'),
            info('audioinput', 'mic-1', 'Headset'),
            info('audioinput', 'mic-1', 'Headset'),
            info('audiooutput', 'out-1', 'Speakers'),
            info('videoinput', 'cam-1', 'Webcam'),
          ]),
      },
    });
    expect(await listDevices()).toEqual({
      audioinput: [
        { deviceId: 'default', label: 'Default' },
        { deviceId: 'mic-1', label: 'Headset' },
      ],
      audiooutput: [{ deviceId: 'out-1', label: 'Speakers' }],
      videoinput: [{ deviceId: 'cam-1', label: 'Webcam' }],
      labelsHidden: false,
      supported: true,
    });
  });

  it('without permission: labels hidden, id-less entries dropped', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: () => Promise.resolve([info('audioinput', '', ''), info('videoinput', '', '')]),
      },
    });
    expect(await listDevices()).toEqual({
      audioinput: [],
      audiooutput: [],
      videoinput: [],
      labelsHidden: true,
      supported: true,
    });
  });

  it('no mediaDevices (insecure origin) or a failure: empty, never rejects', async () => {
    vi.stubGlobal('navigator', {});
    expect(await listDevices()).toMatchObject({ supported: false, audioinput: [] });
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: () => Promise.reject(new Error('x')) } });
    expect(await listDevices()).toMatchObject({ supported: true, audioinput: [] });
  });
});

describe('output selection support', () => {
  it('canSelectOutput follows HTMLMediaElement.setSinkId', () => {
    vi.stubGlobal('HTMLMediaElement', function HTMLMediaElement() {});
    expect(canSelectOutput()).toBe(false);
    vi.stubGlobal(
      'HTMLMediaElement',
      class {
        setSinkId() {
          return Promise.resolve();
        }
      },
    );
    expect(canSelectOutput()).toBe(true);
  });

  it('canPromptOutput follows mediaDevices.selectAudioOutput (Firefox)', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(canPromptOutput()).toBe(false);
    vi.stubGlobal('navigator', { mediaDevices: { selectAudioOutput: () => Promise.resolve() } });
    expect(canPromptOutput()).toBe(true);
  });
});
