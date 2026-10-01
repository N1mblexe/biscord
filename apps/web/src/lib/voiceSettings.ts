import { dbToFraction, LEVEL_FLOOR_DB } from '../voice/levelMeter';
import type { KeyBinding, VoicePrefs } from '../voice/prefs';

/**
 * Pure helpers for Settings → Voice & video (docs/plans/devices.md, "UI contract"): the shortcut
 * recorder's state and the level meter's numbers (device options: components/voice/menuModel.ts).
 * No DOM, no React.
 */

/** The three recordable bindings. */
export type RecorderTarget = 'pttKey' | 'muteKey' | 'deafenKey';

export type RecorderOutcome = 'set' | 'cancelled' | 'conflict';

export interface RecorderState {
  /** The binding being recorded (at most one at a time). */
  recording: RecorderTarget | null;
  /** How the last recording ended, for the polite announcement. */
  last: { target: RecorderTarget; outcome: RecorderOutcome } | null;
}

export type RecorderAction =
  | { type: 'start'; target: RecorderTarget }
  /** The recording of `target` ended; ignored when another one has started since (a stale result). */
  | { type: 'finish'; target: RecorderTarget; outcome: RecorderOutcome }
  /** Stop whatever is recording (blur, a second click), as a cancel. */
  | { type: 'cancel' };

export const RECORDER_IDLE: RecorderState = Object.freeze({ recording: null, last: null });

export function recorderReducer(state: RecorderState, action: RecorderAction): RecorderState {
  switch (action.type) {
    case 'start':
      if (state.recording === action.target) return state;
      return { recording: action.target, last: null };
    case 'finish':
      if (state.recording !== action.target) return state;
      return { recording: null, last: { target: action.target, outcome: action.outcome } };
    case 'cancel':
      if (state.recording === null) return state;
      return { recording: null, last: { target: state.recording, outcome: 'cancelled' } };
  }
}

export function sameBinding(a: KeyBinding | null, b: KeyBinding | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type === 'key') return b.type === 'key' && a.code === b.code;
  return b.type === 'mouse' && a.button === b.button;
}

/**
 * The prefs patch for recording `binding` as `target`. The new binding wins: the mute or deafen
 * shortcut that already had it is cleared. A mute or deafen shortcut can't take the push-to-talk
 * key (one press would do both), so that is a `conflict` and nothing changes.
 */
export function assignBinding(
  prefs: Pick<VoicePrefs, RecorderTarget>,
  target: RecorderTarget,
  binding: KeyBinding,
): { patch: Partial<Pick<VoicePrefs, RecorderTarget>> } | { conflict: true } {
  if (target !== 'pttKey' && sameBinding(prefs.pttKey, binding)) return { conflict: true };
  const patch: Partial<Pick<VoicePrefs, RecorderTarget>> = { [target]: binding };
  for (const other of ['muteKey', 'deafenKey'] as const) {
    if (other !== target && sameBinding(prefs[other], binding)) patch[other] = null;
  }
  return { patch };
}

/** A level for the `<meter>` and its `data-level`: whole dB in −100…0 (non-finite → the floor). */
export function meterLevel(db: number): number {
  if (!Number.isFinite(db)) return LEVEL_FLOOR_DB;
  return Math.round(Math.min(0, Math.max(LEVEL_FLOOR_DB, db)));
}

/** Where the sensitivity marker sits along the meter, as a CSS percentage. */
export function thresholdPosition(thresholdDb: number): string {
  return `${String(Math.round(dbToFraction(thresholdDb) * 1000) / 10)}%`;
}

/** The `setSinkId` argument for an output preference: `''` is the system default in every browser. */
export function sinkIdFor(outputId: string): string {
  return outputId === 'default' ? '' : outputId;
}
