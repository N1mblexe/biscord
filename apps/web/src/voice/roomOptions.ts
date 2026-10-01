import type { AudioCaptureOptions, AudioOutputOptions, VideoCaptureOptions } from 'livekit-client';
import { CAMERA_QUALITY, type VoicePrefs } from './prefs';

/**
 * Voice prefs → LiveKit capture options (pure; only LiveKit *types*, so no runtime import). With the
 * default prefs these equal LiveKit's own defaults, so nothing changes for anyone who never opens
 * the settings: default devices, processing on (voice isolation with noise suppression), 720p30.
 */

/** The device ids in use per kind (`'default'` = system default), after `resolveDevice`. */
export interface ResolvedDevices {
  audioinput: string;
  audiooutput: string;
  videoinput: string;
}

/**
 * The mic's device constraint. Chromium ignores an `ideal` (or bare) audio `deviceId` and opens the
 * system default, so a chosen mic is asked for `exact`ly; capture that fails because the device is
 * gone falls back to the default (engine, `isMissingDevice`). The system default stays `ideal`.
 */
export function micDeviceConstraint(deviceId: string): ConstrainDOMString {
  return deviceId === 'default' ? { ideal: 'default' } : { exact: deviceId };
}

/** Mic constraints that capture the system default instead of `constraints`' device (device-gone fallback). */
export function withDefaultMic<T extends { deviceId?: ConstrainDOMString }>(constraints: T): T {
  return { ...constraints, deviceId: micDeviceConstraint('default') };
}

/** `getUserMedia` failed because the asked-for device isn't there (an `exact` id that went away). */
export function isMissingDevice(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return error.name === 'OverconstrainedError' || error.name === 'NotFoundError';
}

/**
 * Mic constraints for capture and `restartMic`: the processing flags of `audioConstraints`, the
 * device as `micDeviceConstraint`, plus voice isolation (follows noise suppression).
 */
export function micConstraints(
  prefs: VoicePrefs,
  deviceId: string,
): MediaTrackConstraints & AudioCaptureOptions {
  return {
    deviceId: micDeviceConstraint(deviceId),
    noiseSuppression: prefs.noiseSuppression,
    echoCancellation: prefs.echoCancellation,
    autoGainControl: prefs.autoGainControl,
    voiceIsolation: prefs.noiseSuppression,
  };
}

/** Camera capture options: the device and the chosen quality preset (CONTRACTS B.6b rule 3). */
export function cameraCaptureOptions(prefs: VoicePrefs, deviceId: string): VideoCaptureOptions {
  const { width, height, frameRate } = CAMERA_QUALITY[prefs.cameraQuality];
  return {
    deviceId: { ideal: deviceId },
    resolution: { width, height, frameRate, aspectRatio: width / height },
  };
}

export interface CaptureRoomOptions {
  audioCaptureDefaults: AudioCaptureOptions;
  videoCaptureDefaults: VideoCaptureOptions;
  /** Omitted for the system default, as before: LiveKit then never calls `setSinkId`. */
  audioOutput?: AudioOutputOptions;
}

/** The `RoomOptions` capture part for `prefs` with the devices in `devices`. */
export function roomOptionsFromPrefs(prefs: VoicePrefs, devices: ResolvedDevices): CaptureRoomOptions {
  const options: CaptureRoomOptions = {
    audioCaptureDefaults: micConstraints(prefs, devices.audioinput),
    videoCaptureDefaults: cameraCaptureOptions(prefs, devices.videoinput),
  };
  if (devices.audiooutput !== 'default') options.audioOutput = { deviceId: devices.audiooutput };
  return options;
}
