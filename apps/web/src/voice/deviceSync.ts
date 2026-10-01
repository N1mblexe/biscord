import { Track, type LocalAudioTrack, type LocalVideoTrack, type Room } from 'livekit-client';
import { voiceMessage, type VoiceController, type VoiceMessageId } from './controller';
import { canSelectOutput, listDevices, resolveDevice, type DeviceKind } from './devices';
import { useVoicePrefs, type VoicePrefs } from './prefs';
import {
  cameraCaptureOptions,
  micConstraints,
  roomOptionsFromPrefs,
  type ResolvedDevices,
} from './roomOptions';
import { useVoiceSession } from './session';

/**
 * Keeps the LiveKit room in step with the voice prefs (docs/plans/devices.md, engine): device,
 * processing and camera-quality changes apply live, and a device that disappears falls back to the
 * system default with a notice while the stored preference is kept (CONTRACTS B.12 rule 4), so
 * plugging it back in restores it. Part of the lazy LiveKit chunk.
 */

/** The devices to start with: the preferences as they are (capture uses `ideal`, so a missing one falls back). */
export function preferredDevices(prefs: VoicePrefs): ResolvedDevices {
  return { audioinput: prefs.audioInputId, audiooutput: prefs.audioOutputId, videoinput: prefs.videoInputId };
}

const PREF_FIELD = {
  audioinput: 'audioInputId',
  audiooutput: 'audioOutputId',
  videoinput: 'videoInputId',
} as const satisfies Record<DeviceKind, keyof VoicePrefs>;

const LOST_MESSAGE = {
  audioinput: 'micLost',
  audiooutput: 'outputLost',
  videoinput: 'cameraLost',
} as const satisfies Record<DeviceKind, VoiceMessageId>;

const KINDS = ['audioinput', 'audiooutput', 'videoinput'] as const satisfies readonly DeviceKind[];

function processingChanged(a: VoicePrefs, b: VoicePrefs): boolean {
  return (
    a.noiseSuppression !== b.noiseSuppression ||
    a.echoCancellation !== b.echoCancellation ||
    a.autoGainControl !== b.autoGainControl
  );
}

export function micTrack(room: Room): LocalAudioTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
}

export function cameraTrack(room: Room): LocalVideoTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
}

function isLive(): boolean {
  const { state } = useVoiceSession.getState();
  return state === 'connected' || state === 'reconnecting';
}

/**
 * Starts syncing; `devices` is the engine's record of the devices in use (read by the camera port),
 * updated in place. Returns the stop function.
 */
export function startDeviceSync(opts: {
  room: Room;
  controller: VoiceController;
  devices: ResolvedDevices;
  notify: (message: string) => void;
}): () => void {
  const { room, controller, devices, notify } = opts;
  let appliedPrefs = useVoicePrefs.getState().prefs;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  const failed = () => {
    notify(voiceMessage('switchFailed'));
  };

  const reconcile = async () => {
    const prefs = useVoicePrefs.getState().prefs;
    const lists = await listDevices();
    if (stopped) return;
    const prevPrefs = appliedPrefs;
    const prev: ResolvedDevices = { ...devices };
    const next: ResolvedDevices = {
      audioinput: resolveDevice(lists.audioinput, prefs.audioInputId),
      audiooutput: resolveDevice(lists.audiooutput, prefs.audioOutputId),
      videoinput: resolveDevice(lists.videoinput, prefs.videoInputId),
    };
    appliedPrefs = prefs;
    Object.assign(devices, next);

    // The next publish (mic on join, camera on) uses these.
    const options = roomOptionsFromPrefs(prefs, next);
    room.options.audioCaptureDefaults = options.audioCaptureDefaults;
    room.options.videoCaptureDefaults = options.videoCaptureDefaults;

    const live = isLive();
    const mic = micTrack(room);
    const camera = cameraTrack(room);
    const cameraOn = useVoiceSession.getState().camera === 'on' && camera !== undefined;

    // The device in use went away (same preference, it was in use, now not listed).
    if (live) {
      for (const kind of KINDS) {
        const preferred = prefs[PREF_FIELD[kind]];
        const lost =
          preferred !== 'default' &&
          prevPrefs[PREF_FIELD[kind]] === preferred &&
          prev[kind] === preferred &&
          next[kind] === 'default';
        if (!lost) continue;
        if (kind === 'videoinput' && !cameraOn) continue;
        if (kind === 'audiooutput' && !canSelectOutput()) continue;
        notify(voiceMessage(LOST_MESSAGE[kind]));
      }
    }

    if (live && mic && (next.audioinput !== prev.audioinput || processingChanged(prevPrefs, prefs))) {
      await controller.restartMic(micConstraints(prefs, next.audioinput)).catch(failed);
    }

    if (live && cameraOn) {
      if (prefs.cameraQuality !== prevPrefs.cameraQuality) {
        await camera.restartTrack(cameraCaptureOptions(prefs, next.videoinput)).catch(failed);
      } else if (next.videoinput !== prev.videoinput) {
        await room.switchActiveDevice('videoinput', next.videoinput, false).catch(failed);
      }
    }

    if (next.audiooutput !== prev.audiooutput && canSelectOutput()) {
      if (live) {
        await room.switchActiveDevice('audiooutput', next.audiooutput).then(() => undefined, failed);
      } else {
        room.options.audioOutput = { deviceId: next.audiooutput };
      }
    }
  };

  const schedule = () => {
    chain = chain.then(reconcile).catch(() => undefined);
  };

  const unsubscribe = useVoicePrefs.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs) schedule();
  });
  const md =
    typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices as MediaDevices | undefined);
  md?.addEventListener('devicechange', schedule);
  // Learn the device list now (a preference for a device that is already gone falls back).
  schedule();

  return () => {
    stopped = true;
    unsubscribe();
    md?.removeEventListener('devicechange', schedule);
  };
}
