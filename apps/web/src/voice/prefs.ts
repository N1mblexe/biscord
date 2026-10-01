import { VoicePrefsFields } from '@hearth/shared';
import type { CameraQuality, VoicePrefs } from '@hearth/shared';
import { create } from 'zustand';

/**
 * Voice and video device preferences (CONTRACTS B.12, docs/plans/devices.md): per browser, never
 * sent to the server. Stored as JSON in localStorage and validated field by field on read, so one
 * bad or missing field falls back to its default and the rest survive. Storage can be unavailable
 * (private mode, blocked): the preferences then apply to this page only.
 */

export type { CameraQuality, InputMode, KeyBinding, VoicePrefs } from '@hearth/shared';

export const VOICE_PREFS_KEY = 'hearth:voice-prefs';

/** Today's behaviour: default devices, browser processing on, always transmit, 720p. */
export const DEFAULT_VOICE_PREFS: VoicePrefs = Object.freeze({
  audioInputId: 'default',
  audioOutputId: 'default',
  videoInputId: 'default',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  inputMode: 'voice',
  vadGate: false,
  vadThresholdDb: -50,
  pttKey: Object.freeze({ type: 'key', code: 'Backquote' }),
  pttReleaseMs: 200,
  muteKey: null,
  deafenKey: null,
  cameraQuality: '720p',
});

/** Camera capture presets (CONTRACTS B.6b rule 3): all 30 fps. */
export const CAMERA_QUALITY: Readonly<
  Record<CameraQuality, { readonly width: number; readonly height: number; readonly frameRate: 30 }>
> = Object.freeze({
  '360p': Object.freeze({ width: 640, height: 360, frameRate: 30 }),
  '720p': Object.freeze({ width: 1280, height: 720, frameRate: 30 }),
  '1080p': Object.freeze({ width: 1920, height: 1080, frameRate: 30 }),
});

const FIELDS = Object.keys(VoicePrefsFields) as (keyof VoicePrefs)[];

/** Any value → valid prefs: each field that fails validation falls back to its default; ranges are clamped. */
export function parseVoicePrefs(raw: unknown): VoicePrefs {
  const source =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const parsed = VoicePrefsFields[key].safeParse(source[key]);
    out[key] = parsed.success ? parsed.data : DEFAULT_VOICE_PREFS[key];
  }
  return out as unknown as VoicePrefs;
}

/** The saved prefs (defaults when nothing valid is stored); never throws. */
export function readVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(VOICE_PREFS_KEY);
    if (raw === null) return parseVoicePrefs({});
    return parseVoicePrefs(JSON.parse(raw));
  } catch {
    return parseVoicePrefs({});
  }
}

/** Saves `prefs`; storage failures are ignored (the prefs then last for this page only). */
export function writeVoicePrefs(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable.
  }
}

interface VoicePrefsState {
  prefs: VoicePrefs;
  /** Merges `patch`, validates the result (invalid fields keep their current value), saves and notifies. */
  update: (patch: Partial<VoicePrefs>) => void;
  /** Back to the defaults (saved). */
  reset: () => void;
  /** Re-reads storage (another tab changed it, or tests). */
  reload: () => void;
}

export const useVoicePrefs = create<VoicePrefsState>()((set, get) => ({
  prefs: readVoicePrefs(),
  update: (patch) => {
    const current = get().prefs;
    const merged = { ...current, ...patch };
    const next: Record<string, unknown> = {};
    for (const key of FIELDS) {
      const parsed = VoicePrefsFields[key].safeParse(merged[key]);
      next[key] = parsed.success ? parsed.data : current[key];
    }
    const prefs = next as unknown as VoicePrefs;
    if (FIELDS.every((key) => sameValue(prefs[key], current[key]))) return;
    set({ prefs });
    writeVoicePrefs(prefs);
  },
  reset: () => {
    const prefs = parseVoicePrefs({});
    set({ prefs });
    writeVoicePrefs(prefs);
  },
  reload: () => {
    set({ prefs: readVoicePrefs() });
  },
}));

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
