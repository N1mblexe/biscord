import { describe, expect, it } from 'vitest';
import { Track } from 'livekit-client';
import { allPlaybackMuted, attachedVideoWidth, remotePlaybackMuted, videoSourceName } from './debug';

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

describe('voice debug: video', () => {
  it('videoWidth is the widest attached <video>, ignoring audio elements', () => {
    expect(attachedVideoWidth([])).toBe(0);
    expect(
      attachedVideoWidth([
        { tagName: 'AUDIO' },
        { tagName: 'VIDEO', videoWidth: 320 },
        { tagName: 'VIDEO', videoWidth: 960 },
      ]),
    ).toBe(960);
  });

  it('only camera and screen share are video sources', () => {
    expect(videoSourceName(Track.Source.Camera)).toBe('camera');
    expect(videoSourceName(Track.Source.ScreenShare)).toBe('screen_share');
    expect(videoSourceName(Track.Source.Microphone)).toBeNull();
    expect(videoSourceName(Track.Source.ScreenShareAudio)).toBeNull();
  });
});
