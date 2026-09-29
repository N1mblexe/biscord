import {
  ConnectionState,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalTrack,
  type LocalTrackPublication,
  type Participant,
  type Room,
  type TrackPublication,
} from 'livekit-client';
import type { LocalVideoKind, PublishedVideo } from './controller';

/**
 * Tells `onEnded` when our camera or screen share stopped without us asking, judged from the
 * tracks themselves rather than from unpublish events alone: a full reconnect makes LiveKit
 * unpublish and republish every local track (`republishAllTracks`, while the room is
 * `Reconnecting`), and that must not turn anything off.
 *
 * - Screen: the capture track's `TrackEvent.Ended` (the browser's own "Stop sharing").
 * - Camera: LiveKit mutes it when an ended camera can't be restarted (`TrackMuted`, local).
 * - Either: an unpublish while the room is `Connected` (for example the server removed it).
 *
 * Returns the unsubscribe function.
 */
export function watchLocalVideo(room: Room, onEnded: (kind: LocalVideoKind) => void): () => void {
  const onScreenEnded = () => {
    onEnded('screen');
  };
  /** Republishing hands us the same track again: `off` first keeps one listener per track. */
  const watchTrack = (track: LocalTrack) => {
    track.off(TrackEvent.Ended, onScreenEnded).on(TrackEvent.Ended, onScreenEnded);
  };
  const onPublished = (pub: LocalTrackPublication) => {
    if (pub.source === Track.Source.ScreenShare && pub.track) watchTrack(pub.track);
  };
  const onUnpublished = (pub: LocalTrackPublication) => {
    if (room.state !== ConnectionState.Connected) return;
    if (pub.source === Track.Source.ScreenShare) onEnded('screen');
    if (pub.source === Track.Source.Camera) onEnded('camera');
  };
  const onMuted = (pub: TrackPublication, participant: Participant) => {
    if (participant.isLocal && pub.source === Track.Source.Camera) onEnded('camera');
  };

  room
    .on(RoomEvent.LocalTrackPublished, onPublished)
    .on(RoomEvent.LocalTrackUnpublished, onUnpublished)
    .on(RoomEvent.TrackMuted, onMuted);
  return () => {
    room
      .off(RoomEvent.LocalTrackPublished, onPublished)
      .off(RoomEvent.LocalTrackUnpublished, onUnpublished)
      .off(RoomEvent.TrackMuted, onMuted);
    for (const pub of room.localParticipant.trackPublications.values()) {
      pub.track?.off(TrackEvent.Ended, onScreenEnded);
    }
  };
}

/** What `room` really publishes, or `null` while it isn't connected (see `VoiceRoomPort`). */
export function publishedVideo(room: Room): PublishedVideo | null {
  if (room.state !== ConnectionState.Connected) return null;
  return {
    camera: room.localParticipant.isCameraEnabled,
    screen: room.localParticipant.isScreenShareEnabled,
  };
}

/**
 * Unpublishes `published` and stops its capture (camera light off, screen picker session ended).
 * The track is stopped even when LiveKit no longer lists it (unpublishTrack then returns without
 * stopping it, for example after the room disconnected).
 */
export async function unpublishAndStop(
  room: Room,
  published: readonly LocalTrackPublication[],
): Promise<void> {
  await Promise.all(
    published.map(async (pub) => {
      const track = pub.track;
      if (!track) return;
      try {
        await room.localParticipant.unpublishTrack(track, true);
      } finally {
        track.stop();
      }
    }),
  );
}

/** Our screen share's publications: the screen and, when the browser gave us tab audio, its audio. */
export function screenPublications(room: Room): LocalTrackPublication[] {
  const lp = room.localParticipant;
  return [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
    .map((source) => lp.getTrackPublication(source))
    .filter((pub) => pub !== undefined);
}
