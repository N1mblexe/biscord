import type { VoiceStatePayload } from '@hearth/shared';
import { RoomAudioRenderer } from '@livekit/components-react';
import { useQuery } from '@tanstack/react-query';
import {
  RemoteParticipant,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { meQuery } from '../api/auth';
import { fetchVoiceToken } from '../api/voice';
import type { HearthSocket } from '../socket/socket';
import { useSocket } from '../socket/context';
import { useNoticeStore } from '../stores/notice';
import { usePageAlertStore } from '../stores/pageAlert';
import { useVoiceStore } from '../stores/voice';
import { VoiceContext, VoiceRoomContext, type VoiceActions } from './context';
import { createVoiceController, type VoiceController } from './controller';
import { installVoiceDebug } from './debug';
import { publishedVideo, screenPublications, unpublishAndStop, watchLocalVideo } from './localVideo';
import { registerVoiceLeave, useVoiceSession } from './session';
import { energySample, SpeakingMeter } from './speakingMeter';
import { applyUserVolume, useVolumeStore, volumeFor } from './volume';

const VOICE_STATE_ACK_TIMEOUT_MS = 5000;
/** How often audio levels are sampled for the speaking ring. */
const SPEAKING_POLL_MS = 250;

/** Feeds every microphone track in the room to `meter`; returns who is speaking now. */
async function pollSpeaking(room: Room, meter: SpeakingMeter): Promise<string[]> {
  const now = Date.now();
  const present = new Set<string>();
  const jobs: Promise<void>[] = [];
  const sample = (identity: string, track: Track | undefined, statType: 'inbound-rtp' | 'media-source') => {
    present.add(identity);
    if (track === undefined || track.isMuted) {
      meter.update(identity, null, now);
      return;
    }
    jobs.push(
      track
        .getRTCStatsReport()
        .then((report) => {
          meter.update(identity, energySample(report, statType), now);
        })
        .catch(() => undefined),
    );
  };
  for (const p of room.remoteParticipants.values()) {
    sample(p.identity, p.getTrackPublication(Track.Source.Microphone)?.track, 'inbound-rtp');
  }
  const local = room.localParticipant;
  sample(local.identity, local.getTrackPublication(Track.Source.Microphone)?.track, 'media-source');
  await Promise.all(jobs);
  meter.retain(present);
  return meter.speaking(Date.now());
}

function sameKeys(a: Record<string, true>, ids: readonly string[]): boolean {
  const keys = Object.keys(a);
  return keys.length === ids.length && ids.every((id) => a[id] === true);
}

/**
 * `voice:state` sender: only while the socket is connected (a buffered event would arrive stale;
 * the bootstrap after a reconnect triggers a re-sync instead), and never the same payload twice
 * while one is awaiting its ack.
 */
function voiceStateSender(socket: HearthSocket): (payload: VoiceStatePayload) => void {
  let inflight: string | null = null;
  return (payload) => {
    if (!socket.connected) return;
    const key = JSON.stringify(payload);
    if (key === inflight) return;
    inflight = key;
    socket.timeout(VOICE_STATE_ACK_TIMEOUT_MS).emit('voice:state', payload, () => {
      if (inflight === key) inflight = null;
    });
  };
}

function createController(room: Room, socket: HearthSocket): VoiceController {
  const lp = () => room.localParticipant;
  return createVoiceController<LocalTrackPublication>({
    room: {
      connect: (url, token) => room.connect(url, token),
      disconnect: () => room.disconnect(),
      setMicrophoneEnabled: async (enabled) => {
        await lp().setMicrophoneEnabled(enabled);
      },
      // Presets: CONTRACTS B.6b rule 3 (camera 720p30 with LiveKit's default simulcast).
      setCameraEnabled: async (enabled) => {
        const pub = await lp().setCameraEnabled(
          enabled,
          enabled ? { resolution: VideoPresets.h720.resolution } : undefined,
        );
        return enabled && pub ? [pub] : [];
      },
      // Screen 1080p30 tuned for text, no simulcast; tab audio only when the browser offers it.
      setScreenShareEnabled: async (enabled, withAudio) => {
        if (!enabled) {
          await lp().setScreenShareEnabled(false);
          // LiveKit removes the audio only together with a still-published screen; after the
          // browser's own "Stop sharing" the screen is already gone, so remove whatever is left.
          await unpublishAndStop(room, screenPublications(room));
          return [];
        }
        const pub = await lp().setScreenShareEnabled(
          true,
          {
            audio: withAudio,
            resolution: ScreenSharePresets.h1080fps30.resolution,
            contentHint: 'detail',
          },
          { simulcast: false, screenShareEncoding: ScreenSharePresets.h1080fps30.encoding },
        );
        // LiveKit resolves with the screen only; its audio is published alongside.
        const audio = lp().getTrackPublication(Track.Source.ScreenShareAudio);
        return [pub, audio].filter((p) => p !== undefined);
      },
      unpublish: (published) => unpublishAndStop(room, published),
      publishedVideo: () => publishedVideo(room),
    },
    fetchToken: (channelId) => fetchVoiceToken(channelId),
    sendState: voiceStateSender(socket),
    notify: (message) => {
      useNoticeStore.getState().setNotice(message);
    },
    alert: (message) => {
      usePageAlertStore.getState().show(message);
    },
  });
}

/**
 * Voice for the whole signed-in app (docs/plans/phase-6.md, "Key decisions → Web"): one LiveKit
 * `Room` (adaptive stream, dynacast) that lives as long as the protected layout, so voice survives
 * moving between pages. Plays remote audio (microphones and screen-share audio) through
 * `RoomAudioRenderer` (muted while deafened), applies saved per-user volumes to both, tracks active
 * speakers and blocked playback, publishes our camera and screen (phase 7), keeps the server's view
 * of our mute/deafen/camera/screen state in sync, and leaves the room on unmount (logout, revoked
 * session). The room is shared with the video stage through `VoiceRoomContext`.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const { socket } = useSocket();
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true }));
  const [controller] = useState(() => createController(room, socket));
  const deafened = useVoiceSession((s) => s.deafened);
  const meId = useQuery(meQuery).data?.id;

  useEffect(() => {
    const session = () => useVoiceSession.getState();
    const onReconnecting = () => {
      controller.onReconnecting();
    };
    const onReconnected = () => {
      controller.onReconnected();
    };
    const onDisconnected = () => {
      session().set({ speaking: {} });
      controller.onDisconnected();
    };
    const onPlayback = () => {
      session().set({ canPlaybackAudio: room.canPlaybackAudio });
    };
    const onSpeakers = (speakers: Participant[]) => {
      session().set({ speaking: Object.fromEntries(speakers.map((p) => [p.identity, true as const])) });
    };
    const onTrackSubscribed = (
      track: RemoteTrack,
      pub: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.kind !== Track.Kind.Audio) return;
      const source =
        pub.source === Track.Source.ScreenShareAudio
          ? Track.Source.ScreenShareAudio
          : Track.Source.Microphone;
      participant.setVolume(volumeFor(participant.identity), source);
    };
    room
      .on(RoomEvent.Reconnecting, onReconnecting)
      .on(RoomEvent.SignalReconnecting, onReconnecting)
      .on(RoomEvent.Reconnected, onReconnected)
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.Connected, onPlayback)
      .on(RoomEvent.AudioPlaybackStatusChanged, onPlayback)
      .on(RoomEvent.ActiveSpeakersChanged, onSpeakers)
      .on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    // Our camera or screen stopped on its own (the browser's "Stop sharing", a lost camera).
    const unwatchLocalVideo = watchLocalVideo(room, (kind) => {
      controller.onLocalVideoEnded(kind);
    });
    const unregisterLeave = registerVoiceLeave(() => {
      void controller.leave();
    });
    const uninstallDebug = installVoiceDebug(room);

    return () => {
      room
        .off(RoomEvent.Reconnecting, onReconnecting)
        .off(RoomEvent.SignalReconnecting, onReconnecting)
        .off(RoomEvent.Reconnected, onReconnected)
        .off(RoomEvent.Disconnected, onDisconnected)
        .off(RoomEvent.Connected, onPlayback)
        .off(RoomEvent.AudioPlaybackStatusChanged, onPlayback)
        .off(RoomEvent.ActiveSpeakersChanged, onSpeakers)
        .off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      unwatchLocalVideo();
      unregisterLeave();
      uninstallDebug();
      void controller.leave();
    };
  }, [room, controller]);

  // Speaking ring from audio levels, while in a room (LiveKit's active speakers miss short sounds).
  useEffect(() => {
    const meter = new SpeakingMeter();
    let busy = false;
    const timer = setInterval(() => {
      const s = useVoiceSession.getState();
      if (s.state !== 'connected' && s.state !== 'reconnecting') {
        meter.clear();
        if (Object.keys(s.levelSpeaking).length > 0) s.set({ levelSpeaking: {} });
        return;
      }
      if (busy) return;
      busy = true;
      void pollSpeaking(room, meter)
        .then((ids) => {
          const current = useVoiceSession.getState();
          if (current.state === 'disconnected' || sameKeys(current.levelSpeaking, ids)) return;
          current.set({ levelSpeaking: Object.fromEntries(ids.map((id) => [id, true as const])) });
        })
        .finally(() => {
          busy = false;
        });
    }, SPEAKING_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [room]);

  // The server lists us with a different mute/deafen/camera/screen state than ours (it missed a
  // `voice:state` sent before its join webhook, it restarted, or its reconcile cleared a video flag):
  // the controller checks camera/screen against what LiveKit really publishes, then re-sends ours if
  // it still differs.
  useEffect(() => {
    if (meId === undefined) return;
    return useVoiceStore.subscribe((voice) => {
      const s = useVoiceSession.getState();
      if ((s.state !== 'connected' && s.state !== 'reconnecting') || s.channelId === null) return;
      const mine = voice.byChannel[s.channelId]?.find((p) => p.userId === meId);
      if (mine) controller.syncState(mine);
    });
  }, [controller, meId]);

  const actions = useMemo<VoiceActions>(
    () => ({
      join: (channelId) => {
        void controller.join(channelId);
      },
      leave: () => {
        void controller.leave();
      },
      toggleMute: controller.toggleMute,
      toggleDeafen: controller.toggleDeafen,
      toggleCamera: controller.toggleCamera,
      toggleScreen: controller.toggleScreen,
      setUserVolume: (userId, volume) => {
        const applied = useVolumeStore.getState().setVolume(userId, volume);
        const participant = room.getParticipantByIdentity(userId);
        if (participant instanceof RemoteParticipant) applyUserVolume(participant, applied);
      },
      startAudio: () => {
        void room
          .startAudio()
          .catch(() => undefined)
          .finally(() => {
            useVoiceSession.getState().set({ canPlaybackAudio: room.canPlaybackAudio });
          });
      },
    }),
    [controller, room],
  );

  return (
    <VoiceContext value={actions}>
      <VoiceRoomContext value={room}>
        {children}
        {/* Microphones and screen-share audio; deafen mutes both. */}
        <RoomAudioRenderer room={room} muted={deafened} />
      </VoiceRoomContext>
    </VoiceContext>
  );
}
