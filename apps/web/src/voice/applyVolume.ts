import { Track } from 'livekit-client';

/** What a user's volume is applied to (a `RemoteParticipant`). */
export interface VolumeTarget {
  setVolume: (volume: number, source?: Track.Source.Microphone | Track.Source.ScreenShareAudio) => void;
}

/**
 * Applies a user's volume slider to everything we hear from them: their microphone and their
 * screen-share audio (CONTRACTS B.6b rule 2). LiveKit remembers it per source for tracks that are
 * subscribed later.
 */
export function applyUserVolume(target: VolumeTarget, volume: number): void {
  target.setVolume(volume, Track.Source.Microphone);
  target.setVolume(volume, Track.Source.ScreenShareAudio);
}
