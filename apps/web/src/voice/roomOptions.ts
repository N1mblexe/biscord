import type { AudioCaptureOptions, AudioOutputOptions, VideoCaptureOptions } from 'livekit-client';
import { audioConstraints } from './devices';
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

/** Mic constraints for capture and `restartMic`: `audioConstraints` plus voice isolation (follows noise suppression). */
export function micConstraints(
  prefs: VoicePrefs,
  deviceId: string,
): MediaTrackConstraints & AudioCaptureOptions {
  const base = audioConstraints(prefs, deviceId);
  return {
    deviceId: base.deviceId,
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
