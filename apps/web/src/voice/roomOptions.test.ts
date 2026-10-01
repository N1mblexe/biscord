import { VideoPresets } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PREFS } from './prefs';
import {
  cameraCaptureOptions,
  isMissingDevice,
  micConstraints,
  micDeviceConstraint,
  roomOptionsFromPrefs,
  withDefaultMic,
} from './roomOptions';

const defaults = { audioinput: 'default', audiooutput: 'default', videoinput: 'default' };

describe('prefs → RoomOptions', () => {
  it('the defaults equal LiveKit’s own capture defaults (today’s behaviour) and set no output', () => {
    // livekit-client src/room/defaults.ts: audioDefaults / videoDefaults (VideoPresets.h720).
    expect(roomOptionsFromPrefs(DEFAULT_VOICE_PREFS, defaults)).toEqual({
      audioCaptureDefaults: {
        deviceId: { ideal: 'default' },
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        voiceIsolation: true,
      },
      videoCaptureDefaults: {
        deviceId: { ideal: 'default' },
        resolution: { width: 1280, height: 720, frameRate: 30, aspectRatio: 1280 / 720 },
      },
    });
    // The camera preset used before (B.6b): VideoPresets.h720.
    expect(roomOptionsFromPrefs(DEFAULT_VOICE_PREFS, defaults).videoCaptureDefaults.resolution).toEqual(
      VideoPresets.h720.resolution,
    );
  });

  it('maps devices, processing flags and quality', () => {
    const prefs = {
      ...DEFAULT_VOICE_PREFS,
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: true,
      cameraQuality: '1080p' as const,
    };
    expect(
      roomOptionsFromPrefs(prefs, { audioinput: 'mic-1', audiooutput: 'out-2', videoinput: 'cam-3' }),
    ).toEqual({
      audioCaptureDefaults: {
        deviceId: { exact: 'mic-1' },
        noiseSuppression: false,
        echoCancellation: false,
        autoGainControl: true,
        voiceIsolation: false,
      },
      videoCaptureDefaults: {
        deviceId: { ideal: 'cam-3' },
        resolution: { width: 1920, height: 1080, frameRate: 30, aspectRatio: 1920 / 1080 },
      },
      audioOutput: { deviceId: 'out-2' },
    });
  });

  it('360p camera and mic restart constraints', () => {
    expect(cameraCaptureOptions({ ...DEFAULT_VOICE_PREFS, cameraQuality: '360p' }, 'cam-1')).toEqual({
      deviceId: { ideal: 'cam-1' },
      resolution: { width: 640, height: 360, frameRate: 30, aspectRatio: 640 / 360 },
    });
    expect(micConstraints({ ...DEFAULT_VOICE_PREFS, echoCancellation: false }, 'mic-2')).toEqual({
      deviceId: { exact: 'mic-2' },
      noiseSuppression: true,
      echoCancellation: false,
      autoGainControl: true,
      voiceIsolation: true,
    });
  });

  it('a chosen mic is exact (Chromium ignores an ideal audio deviceId); the default stays ideal', () => {
    expect(micDeviceConstraint('mic-2')).toEqual({ exact: 'mic-2' });
    expect(micDeviceConstraint('default')).toEqual({ ideal: 'default' });
    const chosen = micConstraints(DEFAULT_VOICE_PREFS, 'mic-2');
    expect(withDefaultMic(chosen)).toEqual({ ...chosen, deviceId: { ideal: 'default' } });
    expect(chosen.deviceId).toEqual({ exact: 'mic-2' });
  });

  it('isMissingDevice: only a device that is not there', () => {
    expect(isMissingDevice(Object.assign(new Error('x'), { name: 'OverconstrainedError' }))).toBe(true);
    expect(isMissingDevice(new DOMException('gone', 'NotFoundError'))).toBe(true);
    expect(isMissingDevice(new DOMException('denied', 'NotAllowedError'))).toBe(false);
    expect(isMissingDevice(new DOMException('busy', 'NotReadableError'))).toBe(false);
    expect(isMissingDevice('OverconstrainedError')).toBe(false);
    expect(isMissingDevice(null)).toBe(false);
  });
});
