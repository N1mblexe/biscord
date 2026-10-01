import { useCallback, useEffect, useState } from 'react';
import { CAMERA_QUALITY, type VoicePrefs } from './prefs';

/**
 * Media devices through plain `navigator.mediaDevices` (no LiveKit, so this can live in the initial
 * bundle; docs/plans/devices.md). Before the user grants a permission, browsers list devices without
 * labels (and Chromium without ids): `labelsHidden` then tells the UI to offer **Allow access**.
 */

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

/** One device; `label` is `''` while labels are hidden (the UI shows a numbered fallback). */
export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface DeviceLists {
  audioinput: DeviceOption[];
  audiooutput: DeviceOption[];
  videoinput: DeviceOption[];
  /** Some device has no label: the page has no media permission yet. */
  labelsHidden: boolean;
  /** `navigator.mediaDevices.enumerateDevices` exists (false on plain http, except localhost). */
  supported: boolean;
}

const EMPTY: DeviceLists = Object.freeze({
  audioinput: [],
  audiooutput: [],
  videoinput: [],
  labelsHidden: false,
  supported: false,
});

function mediaDevices(): MediaDevices | null {
  // `mediaDevices` is missing on insecure origins even though the DOM types say it's always there.
  if (typeof navigator === 'undefined' || !('mediaDevices' in navigator)) return null;
  return navigator.mediaDevices;
}

/**
 * Today's devices by kind. Chromium lists `'default'` (and `'communications'`) pseudo-devices next
 * to the real ones; they are kept, since `'default'` is how we name the system default anyway.
 * Never rejects: no API or a failure gives empty lists.
 */
export async function listDevices(): Promise<DeviceLists> {
  const md = mediaDevices();
  if (md === null || typeof md.enumerateDevices !== 'function') return EMPTY;
  let infos: MediaDeviceInfo[];
  try {
    infos = await md.enumerateDevices();
  } catch {
    return { ...EMPTY, supported: true };
  }
  const lists: DeviceLists = {
    audioinput: [],
    audiooutput: [],
    videoinput: [],
    labelsHidden: false,
    supported: true,
  };
  const seen = new Set<string>();
  for (const info of infos) {
    if (info.label === '') lists.labelsHidden = true;
    // Without permission Chromium gives one entry per kind with an empty id: nothing to choose yet.
    if (info.deviceId === '') continue;
    const key = `${info.kind}:${info.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lists[info.kind].push({ deviceId: info.deviceId, label: info.label });
  }
  return lists;
}

/**
 * The id to capture with: `preferredId` when it is in `list`, else `'default'` (the device was
 * unplugged). An empty list can't tell (no permission yet, or no API), so the preference is kept.
 */
export function resolveDevice(list: readonly DeviceOption[], preferredId: string): string {
  if (preferredId === 'default' || list.length === 0) return preferredId;
  return list.some((d) => d.deviceId === preferredId) ? preferredId : 'default';
}

/** The browser can route playback to a chosen output (`HTMLMediaElement.setSinkId`; not iOS Safari). */
export function canSelectOutput(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** Firefox: outputs are only listed after `navigator.mediaDevices.selectAudioOutput()` asks the user. */
export function canPromptOutput(): boolean {
  const md = mediaDevices();
  return md !== null && 'selectAudioOutput' in md;
}

/** A device constraint: `ideal`, so a device that went away falls back instead of failing capture. */
function deviceConstraint(deviceId: string): ConstrainDOMString {
  return { ideal: deviceId };
}

/** Microphone constraints from the prefs (device `deviceId`, default the preferred one). */
export function audioConstraints(
  prefs: VoicePrefs,
  deviceId: string = prefs.audioInputId,
): MediaTrackConstraints {
  return {
    deviceId: deviceConstraint(deviceId),
    noiseSuppression: prefs.noiseSuppression,
    echoCancellation: prefs.echoCancellation,
    autoGainControl: prefs.autoGainControl,
  };
}

/** Camera constraints from the prefs: device and the chosen quality (30 fps). */
export function videoConstraints(
  prefs: VoicePrefs,
  deviceId: string = prefs.videoInputId,
): MediaTrackConstraints {
  const { width, height, frameRate } = CAMERA_QUALITY[prefs.cameraQuality];
  return {
    deviceId: deviceConstraint(deviceId),
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: frameRate },
    aspectRatio: { ideal: width / height },
  };
}

/**
 * The device lists, kept fresh on `devicechange`. `requestAccess` asks for the given permissions
 * once (to reveal labels and ids), stops the capture at once and refreshes; it resolves false when
 * denied or unsupported.
 */
export function useMediaDevices(): DeviceLists & {
  refresh: () => void;
  requestAccess: (kinds: { audio?: boolean; video?: boolean }) => Promise<boolean>;
} {
  const [lists, setLists] = useState<DeviceLists>(EMPTY);

  const refresh = useCallback(() => {
    void listDevices().then(setLists);
  }, []);

  useEffect(() => {
    let alive = true;
    const update = () => {
      void listDevices().then((next) => {
        if (alive) setLists(next);
      });
    };
    update();
    const md = mediaDevices();
    md?.addEventListener('devicechange', update);
    return () => {
      alive = false;
      md?.removeEventListener('devicechange', update);
    };
  }, []);

  const requestAccess = useCallback(
    async (kinds: { audio?: boolean; video?: boolean }): Promise<boolean> => {
      const md = mediaDevices();
      if (md === null || typeof md.getUserMedia !== 'function') return false;
      if (kinds.audio !== true && kinds.video !== true) return false;
      try {
        const stream = await md.getUserMedia({ audio: kinds.audio === true, video: kinds.video === true });
        for (const track of stream.getTracks()) track.stop();
        return true;
      } catch {
        return false;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  return { ...lists, refresh, requestAccess };
}
