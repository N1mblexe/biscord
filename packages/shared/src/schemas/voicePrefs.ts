import { z } from 'zod';

/**
 * Voice and video device preferences (CONTRACTS B.12). Client-only: stored per browser in
 * localStorage and never sent to the server. The web app (`voice/prefs.ts`) parses each field on its
 * own, so one bad field falls back to its default without discarding the rest.
 */

export const VAD_THRESHOLD_MIN_DB = -100;
export const VAD_THRESHOLD_MAX_DB = 0;
export const PTT_RELEASE_MAX_MS = 1000;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** A keyboard key (`KeyboardEvent.code`) or a mouse side button (3 = back, 4 = forward). */
export const KeyBinding = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), code: z.string().min(1).max(64) }),
  z.object({ type: z.literal('mouse'), button: z.union([z.literal(3), z.literal(4)]) }),
]);
export type KeyBinding = z.infer<typeof KeyBinding>;

export const InputMode = z.enum(['voice', 'ptt']);
export type InputMode = z.infer<typeof InputMode>;

export const CameraQuality = z.enum(['360p', '720p', '1080p']);
export type CameraQuality = z.infer<typeof CameraQuality>;

/** A `MediaDeviceInfo.deviceId`, or `'default'` for the system default. */
const DeviceId = z.string().min(1).max(512);

/** One schema per field; numbers are clamped into range rather than rejected. */
export const VoicePrefsFields = {
  audioInputId: DeviceId,
  audioOutputId: DeviceId,
  videoInputId: DeviceId,
  noiseSuppression: z.boolean(),
  echoCancellation: z.boolean(),
  autoGainControl: z.boolean(),
  inputMode: InputMode,
  vadGate: z.boolean(),
  vadThresholdDb: z.number().transform((v) => clamp(v, VAD_THRESHOLD_MIN_DB, VAD_THRESHOLD_MAX_DB)),
  pttKey: KeyBinding,
  pttReleaseMs: z.number().transform((v) => Math.round(clamp(v, 0, PTT_RELEASE_MAX_MS))),
  muteKey: KeyBinding.nullable(),
  deafenKey: KeyBinding.nullable(),
  cameraQuality: CameraQuality,
};

export const VoicePrefs = z.object(VoicePrefsFields);
export type VoicePrefs = z.infer<typeof VoicePrefs>;
