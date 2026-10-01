import type { InputMode } from './prefs';

/**
 * The local transmit gate (CONTRACTS B.12 rule 2): push-to-talk and voice activity are a second
 * layer on top of the user's own mute. Pure, so the engine and the tests share it.
 */

export interface GateInput {
  /** The user's own mute (`voice:state.selfMute`). */
  micMuted: boolean;
  deafened: boolean;
  inputMode: InputMode;
  /** The push-to-talk key (or hold button) is held. */
  pttActive: boolean;
  /** Voice activity mode only transmits above the sensitivity threshold. */
  vadGate: boolean;
  /** The level is above the threshold (with hysteresis). */
  vadOpen: boolean;
}

/** Transmit = not muted, not deafened, and (push-to-talk ? held : (no VAD gate, or level above threshold)). */
export function shouldTransmit(s: GateInput): boolean {
  if (s.micMuted || s.deafened) return false;
  if (s.inputMode === 'ptt') return s.pttActive;
  return !s.vadGate || s.vadOpen;
}

/** How long the level must stay below the threshold before the VAD gate closes (no chopped word ends). */
export const VAD_RELEASE_MS = 300;

/** Voice activity with hysteresis: opens at once at or above the threshold, closes `releaseMs` after the last loud sample. */
export function createVadHysteresis(releaseMs: number = VAD_RELEASE_MS): {
  update: (db: number, thresholdDb: number, nowMs: number) => boolean;
  reset: () => void;
} {
  let open = false;
  let lastLoudMs = 0;
  return {
    update: (db, thresholdDb, nowMs) => {
      if (db >= thresholdDb) {
        open = true;
        lastLoudMs = nowMs;
      } else if (open && nowMs - lastLoudMs >= releaseMs) {
        open = false;
      }
      return open;
    },
    reset: () => {
      open = false;
      lastLoudMs = 0;
    },
  };
}
