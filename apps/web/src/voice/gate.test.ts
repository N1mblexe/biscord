import { describe, expect, it } from 'vitest';
import { createVadHysteresis, shouldTransmit, VAD_RELEASE_MS, type GateInput } from './gate';

const base: GateInput = {
  micMuted: false,
  deafened: false,
  inputMode: 'voice',
  pttActive: false,
  vadGate: false,
  vadOpen: false,
};

describe('shouldTransmit (CONTRACTS B.12 rule 2)', () => {
  // [inputMode, pttActive, vadGate, vadOpen] → transmit while not muted or deafened.
  const table: [GateInput['inputMode'], boolean, boolean, boolean, boolean][] = [
    ['voice', false, false, false, true], // the default: always transmit
    ['voice', true, false, false, true],
    ['voice', false, true, false, false], // VAD gate closed
    ['voice', false, true, true, true], // VAD gate open
    ['voice', true, true, false, false], // PTT is ignored in voice mode
    ['ptt', false, false, false, false],
    ['ptt', true, false, false, true],
    ['ptt', false, true, true, false], // VAD is ignored in PTT mode
    ['ptt', true, true, false, true],
  ];

  it.each(table)(
    '%s ptt=%s vadGate=%s vadOpen=%s → %s',
    (inputMode, pttActive, vadGate, vadOpen, expected) => {
      expect(shouldTransmit({ ...base, inputMode, pttActive, vadGate, vadOpen })).toBe(expected);
    },
  );

  it.each(table)(
    'never while muted or deafened (%s ptt=%s vadGate=%s vadOpen=%s)',
    (inputMode, pttActive, vadGate, vadOpen) => {
      const s = { ...base, inputMode, pttActive, vadGate, vadOpen };
      expect(shouldTransmit({ ...s, micMuted: true })).toBe(false);
      expect(shouldTransmit({ ...s, deafened: true })).toBe(false);
      expect(shouldTransmit({ ...s, micMuted: true, deafened: true })).toBe(false);
    },
  );
});

describe('VAD hysteresis', () => {
  it('opens at once at or above the threshold', () => {
    const vad = createVadHysteresis();
    expect(vad.update(-60, -50, 0)).toBe(false);
    expect(vad.update(-50, -50, 20)).toBe(true);
  });

  it('closes only after releaseMs below the threshold; a loud sample meanwhile extends it', () => {
    const vad = createVadHysteresis(300);
    vad.update(-20, -50, 1000);
    expect(vad.update(-80, -50, 1100)).toBe(true);
    expect(vad.update(-30, -50, 1250)).toBe(true); // loud again: the hold restarts
    expect(vad.update(-80, -50, 1500)).toBe(true);
    expect(vad.update(-80, -50, 1549)).toBe(true);
    expect(vad.update(-80, -50, 1550)).toBe(false);
    expect(vad.update(-80, -50, 5000)).toBe(false);
  });

  it('uses VAD_RELEASE_MS by default and reset closes it', () => {
    const vad = createVadHysteresis();
    vad.update(0, -50, 0);
    expect(vad.update(-100, -50, VAD_RELEASE_MS - 1)).toBe(true);
    expect(vad.update(-100, -50, VAD_RELEASE_MS)).toBe(false);
    vad.update(0, -50, 1000);
    vad.reset();
    expect(vad.update(-100, -50, 1001)).toBe(false);
  });

  it('follows a threshold change on the next sample', () => {
    const vad = createVadHysteresis();
    expect(vad.update(-40, -30, 0)).toBe(false);
    expect(vad.update(-40, -45, 20)).toBe(true);
  });
});
