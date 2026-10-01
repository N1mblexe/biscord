import { Track, type Room } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceController } from './controller';
import { voiceMessage } from './controller';
import { preferredDevices, startDeviceSync } from './deviceSync';
import { DEFAULT_VOICE_PREFS, useVoicePrefs } from './prefs';
import { useVoiceSession } from './session';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function device(kind: MediaDeviceKind, deviceId: string) {
  return { kind, deviceId, label: deviceId, groupId: 'g' };
}

function setup() {
  let infos = [
    device('audioinput', 'default'),
    device('audioinput', 'mic-1'),
    device('audiooutput', 'default'),
    device('audiooutput', 'out-1'),
    device('videoinput', 'cam-1'),
    device('videoinput', 'cam-2'),
  ];
  let onDeviceChange: (() => void) | null = null;
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: () => Promise.resolve(infos),
      addEventListener: (_type: string, fn: () => void) => {
        onDeviceChange = fn;
      },
      removeEventListener: () => {
        onDeviceChange = null;
      },
    },
  });
  vi.stubGlobal(
    'HTMLMediaElement',
    class {
      setSinkId() {
        return Promise.resolve();
      }
    },
  );
  const log: string[] = [];
  const mic = { kind: 'mic' };
  const camera = {
    restartTrack: (opts: unknown) => {
      log.push(`camera restart ${JSON.stringify(opts)}`);
      return Promise.resolve();
    },
  };
  const published = { mic: true, camera: false };
  const room = {
    options: {} as Record<string, unknown>,
    localParticipant: {
      getTrackPublication: (source: Track.Source) => {
        if (source === Track.Source.Microphone && published.mic) return { audioTrack: mic };
        if (source === Track.Source.Camera && published.camera) return { videoTrack: camera };
        return undefined;
      },
    },
    switchActiveDevice: (kind: string, id: string) => {
      log.push(`switch ${kind} ${id}`);
      return Promise.resolve(true);
    },
  };
  const controller = {
    restartMic: (constraints: MediaTrackConstraints) => {
      log.push(`mic restart ${JSON.stringify(constraints)}`);
      return Promise.resolve();
    },
  };
  const notices: string[] = [];
  const devices = preferredDevices(useVoicePrefs.getState().prefs);
  const stop = startDeviceSync({
    room: room as unknown as Room,
    controller: controller as unknown as VoiceController,
    devices,
    notify: (message) => {
      notices.push(message);
    },
  });
  return {
    log,
    notices,
    devices,
    room,
    published,
    stop,
    setDevices: async (next: typeof infos) => {
      infos = next;
      onDeviceChange?.();
      await flush();
    },
    all: () => infos,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', undefined);
  useVoicePrefs.setState({ prefs: { ...DEFAULT_VOICE_PREFS, audioInputId: 'mic-1' } });
  useVoiceSession.getState().reset();
  useVoiceSession.getState().set({ state: 'connected', channelId: 'c' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useVoiceSession.getState().reset();
});

describe('device sync (engine)', () => {
  it('a present preferred device needs no switch; room options follow the prefs', async () => {
    const s = setup();
    await flush();
    expect(s.log).toEqual([]);
    expect(s.devices.audioinput).toBe('mic-1');
    expect(s.room.options.audioCaptureDefaults).toMatchObject({ deviceId: { ideal: 'mic-1' } });
    s.stop();
  });

  it('a lost mic falls back to default with a notice, keeps the preference, and comes back on re-plug', async () => {
    const s = setup();
    await flush();
    const plugged = s.all();
    await s.setDevices(plugged.filter((d) => d.deviceId !== 'mic-1'));
    expect(s.notices).toEqual([voiceMessage('micLost')]);
    expect(s.log).toEqual([expect.stringMatching(/^mic restart .*"ideal":"default"/)]);
    expect(useVoicePrefs.getState().prefs.audioInputId).toBe('mic-1');

    await s.setDevices(plugged);
    expect(s.log.at(-1)).toMatch(/^mic restart .*"ideal":"mic-1"/);
    expect(s.notices).toHaveLength(1);
    s.stop();
  });

  it('processing changes restart the mic with the new flags', async () => {
    const s = setup();
    await flush();
    useVoicePrefs.getState().update({ noiseSuppression: false });
    await flush();
    expect(s.log).toEqual([
      'mic restart {"deviceId":{"ideal":"mic-1"},"noiseSuppression":false,"echoCancellation":true,"autoGainControl":true,"voiceIsolation":false}',
    ]);
    s.stop();
  });

  it('camera: quality restarts the track, a device change switches it (only while on)', async () => {
    const s = setup();
    await flush();
    useVoicePrefs.getState().update({ videoInputId: 'cam-2' });
    await flush();
    expect(s.log).toEqual([]); // camera off: only the options change
    expect(s.room.options.videoCaptureDefaults).toMatchObject({ deviceId: { ideal: 'cam-2' } });

    s.published.camera = true;
    useVoiceSession.getState().set({ camera: 'on' });
    useVoicePrefs.getState().update({ cameraQuality: '360p' });
    await flush();
    expect(s.log).toEqual([
      'camera restart {"deviceId":{"ideal":"cam-2"},"resolution":{"width":640,"height":360,"frameRate":30,"aspectRatio":1.7777777777777777}}',
    ]);
    useVoicePrefs.getState().update({ videoInputId: 'cam-1' });
    await flush();
    expect(s.log.at(-1)).toBe('switch videoinput cam-1');
    s.stop();
  });

  it('output: switched live where setSinkId exists', async () => {
    const s = setup();
    await flush();
    useVoicePrefs.getState().update({ audioOutputId: 'out-1' });
    await flush();
    expect(s.log).toEqual(['switch audiooutput out-1']);
    s.stop();
  });

  it('out of voice nothing restarts and no notice shows', async () => {
    useVoiceSession.getState().set({ state: 'disconnected', channelId: null });
    const s = setup();
    s.published.mic = false;
    await flush();
    await s.setDevices(s.all().filter((d) => d.deviceId !== 'mic-1'));
    useVoicePrefs.getState().update({ echoCancellation: false, audioOutputId: 'out-1' });
    await flush();
    expect(s.log).toEqual([]);
    expect(s.notices).toEqual([]);
    expect(s.room.options.audioOutput).toEqual({ deviceId: 'out-1' });
    s.stop();
  });
});
