import { describe, expect, it } from 'vitest';
import { allPlaybackMuted, remotePlaybackMuted } from './debug';

describe('voice debug: playback mute comes from the real publication state', () => {
  it('a remote is muted only when its microphone publication is disabled locally', () => {
    // `RoomAudioRenderer muted` (deafen) calls `setEnabled(false)` → `isEnabled` false.
    expect(remotePlaybackMuted({ isEnabled: false })).toBe(true);
    expect(remotePlaybackMuted({ isEnabled: true })).toBe(false);
    // No microphone publication: nothing to mute.
    expect(remotePlaybackMuted(undefined)).toBe(false);
  });

  it('playbackMuted needs at least one remote, and every remote muted', () => {
    expect(allPlaybackMuted([])).toBe(false);
    expect(allPlaybackMuted([{ muted: true }])).toBe(true);
    expect(allPlaybackMuted([{ muted: true }, { muted: true }])).toBe(true);
    expect(allPlaybackMuted([{ muted: true }, { muted: false }])).toBe(false);
    expect(allPlaybackMuted([{ muted: false }])).toBe(false);
  });
});
