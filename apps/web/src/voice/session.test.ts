import { describe, expect, it } from 'vitest';
import { toggleDeafen, toggleMute, type MicState } from './session';

const live: MicState = { micMuted: false, deafened: false, mutedBeforeDeafen: false };

describe('mute / deafen state machine', () => {
  it('mute flips the mic', () => {
    const muted = toggleMute(live);
    expect(muted).toEqual({ micMuted: true, deafened: false, mutedBeforeDeafen: false });
    expect(toggleMute(muted)).toEqual(live);
  });

  it('deafen self-mutes; undeafen restores an unmuted mic', () => {
    const deaf = toggleDeafen(live);
    expect(deaf).toEqual({ micMuted: true, deafened: true, mutedBeforeDeafen: false });
    expect(toggleDeafen(deaf)).toEqual(live);
  });

  it('undeafen restores a mic that was muted before deafening', () => {
    const deaf = toggleDeafen(toggleMute(live));
    expect(deaf).toEqual({ micMuted: true, deafened: true, mutedBeforeDeafen: true });
    expect(toggleDeafen(deaf)).toEqual({ micMuted: true, deafened: false, mutedBeforeDeafen: false });
  });

  it('unmuting while deafened also undeafens', () => {
    const deaf = toggleDeafen(toggleMute(live));
    expect(toggleMute(deaf)).toEqual(live);
  });
});
