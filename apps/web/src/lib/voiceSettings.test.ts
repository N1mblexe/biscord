import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PREFS } from '../voice/prefs';
import {
  assignBinding,
  meterLevel,
  RECORDER_IDLE,
  recorderReducer,
  sameBinding,
  sinkIdFor,
  thresholdPosition,
} from './voiceSettings';

describe('recorderReducer', () => {
  it('records one binding at a time and reports how it ended', () => {
    let state = recorderReducer(RECORDER_IDLE, { type: 'start', target: 'pttKey' });
    expect(state).toEqual({ recording: 'pttKey', last: null });
    state = recorderReducer(state, { type: 'finish', target: 'pttKey', outcome: 'set' });
    expect(state).toEqual({ recording: null, last: { target: 'pttKey', outcome: 'set' } });
  });

  it('switching to another binding replaces the recording, and the stale result is ignored', () => {
    let state = recorderReducer(RECORDER_IDLE, { type: 'start', target: 'muteKey' });
    state = recorderReducer(state, { type: 'start', target: 'deafenKey' });
    expect(state.recording).toBe('deafenKey');
    const stale = recorderReducer(state, { type: 'finish', target: 'muteKey', outcome: 'set' });
    expect(stale).toBe(state);
  });

  it('cancel stops the recording (blur, a second click) and is a no-op when idle', () => {
    const recording = recorderReducer(RECORDER_IDLE, { type: 'start', target: 'muteKey' });
    expect(recorderReducer(recording, { type: 'cancel' })).toEqual({
      recording: null,
      last: { target: 'muteKey', outcome: 'cancelled' },
    });
    expect(recorderReducer(RECORDER_IDLE, { type: 'cancel' })).toBe(RECORDER_IDLE);
  });

  it('starting the same binding again changes nothing', () => {
    const state = recorderReducer(RECORDER_IDLE, { type: 'start', target: 'pttKey' });
    expect(recorderReducer(state, { type: 'start', target: 'pttKey' })).toBe(state);
  });
});

describe('assignBinding', () => {
  const keyM = { type: 'key', code: 'KeyM' } as const;
  const mouse4 = { type: 'mouse', button: 3 } as const;

  it('sets the binding', () => {
    expect(assignBinding(DEFAULT_VOICE_PREFS, 'muteKey', keyM)).toEqual({ patch: { muteKey: keyM } });
    expect(assignBinding(DEFAULT_VOICE_PREFS, 'pttKey', mouse4)).toEqual({ patch: { pttKey: mouse4 } });
  });

  it('moves a key from the other shortcut instead of binding it twice', () => {
    const prefs = { ...DEFAULT_VOICE_PREFS, muteKey: keyM };
    expect(assignBinding(prefs, 'deafenKey', keyM)).toEqual({ patch: { deafenKey: keyM, muteKey: null } });
    expect(assignBinding(prefs, 'pttKey', keyM)).toEqual({ patch: { pttKey: keyM, muteKey: null } });
  });

  it('refuses the push-to-talk key for mute or deafen', () => {
    expect(assignBinding(DEFAULT_VOICE_PREFS, 'muteKey', DEFAULT_VOICE_PREFS.pttKey)).toEqual({
      conflict: true,
    });
  });

  it('sameBinding compares keys and mouse buttons', () => {
    expect(sameBinding(keyM, { type: 'key', code: 'KeyM' })).toBe(true);
    expect(sameBinding(keyM, mouse4)).toBe(false);
    expect(sameBinding(mouse4, { type: 'mouse', button: 4 })).toBe(false);
    expect(sameBinding(null, null)).toBe(true);
    expect(sameBinding(null, keyM)).toBe(false);
  });
});

describe('meter mapping', () => {
  it('meterLevel gives whole dB in −100…0', () => {
    expect(meterLevel(-42.6)).toBe(-43);
    expect(meterLevel(-250)).toBe(-100);
    expect(meterLevel(3)).toBe(0);
    expect(meterLevel(Number.NaN)).toBe(-100);
    expect(meterLevel(Number.NEGATIVE_INFINITY)).toBe(-100);
  });

  it('thresholdPosition places the marker along the bar', () => {
    expect(thresholdPosition(-100)).toBe('0%');
    expect(thresholdPosition(-50)).toBe('50%');
    expect(thresholdPosition(0)).toBe('100%');
    expect(thresholdPosition(-33.33)).toBe('66.7%');
  });

  it('sinkIdFor maps the default output to the empty sink id', () => {
    expect(sinkIdFor('default')).toBe('');
    expect(sinkIdFor('abc')).toBe('abc');
  });
});
