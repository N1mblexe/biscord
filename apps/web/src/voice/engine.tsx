import type { Ack, VoiceStatePayload } from '@hearth/shared';
import { RoomAudioRenderer } from '@livekit/components-react';
import { useQuery } from '@tanstack/react-query';
import {
  RemoteParticipant,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  TrackEvent,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useEffect } from 'react';
import { meQuery } from '../api/auth';
import { fetchVoiceToken } from '../api/voice';
import type { HearthSocket } from '../socket/socket';
import { useNoticeStore } from '../stores/notice';
import { usePageAlertStore } from '../stores/pageAlert';
import { useVoiceStore } from '../stores/voice';
import { applyUserVolume } from './applyVolume';
import type { EngineVoiceActions } from './context';
import { createVoiceController, type VoiceController } from './controller';
import { voiceDebug } from './debug';
import { micTrack, preferredDevices, startDeviceSync } from './deviceSync';
import { createVadHysteresis } from './gate';
import { createLevelMeter, type LevelMeter } from './levelMeter';
import { publishedVideo, screenPublications, unpublishAndStop, watchLocalVideo } from './localVideo';
import { useVoicePrefs } from './prefs';
import { isMissingDevice, withDefaultMic } from './devices';
import { cameraCaptureOptions, roomOptionsFromPrefs, type ResolvedDevices } from './roomOptions';
import { useVoiceSession } from './session';
import { energySample, SpeakingMeter } from './speakingMeter';
import { createVoiceStateSender } from './stateSender';
import { useVolumeStore, volumeFor } from './volume';

/**
 * The voice engine: everything that needs LiveKit (`livekit-client`, `@livekit/components-react`),
 * in its own lazy chunk (docs/plans/phase-8.md, "Bundle size"). voice/VoiceProvider.tsx loads it on
 * the first join and keeps it for the rest of the signed-in session.
 */

export { VideoStage } from './VideoStage';

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

function isLive(): boolean {
  const { state } = useVoiceSession.getState();
  return state === 'connected' || state === 'reconnecting';
}

/**
 * Feeds the controller's gate: the input mode and VAD settings from the prefs, `pttActive` from the
 * session (VoiceProvider's push-to-talk), and voice activity from a level meter on (a clone of) the
 * published mic, which runs only in voice-activity mode with the gate on and is rebuilt whenever the
 * mic track is replaced (device switch, processing change). Returns the stop function.
 */
function startLocalGate(room: Room, controller: VoiceController): () => void {
  const prefs = () => useVoicePrefs.getState().prefs;
  const hysteresis = createVadHysteresis();
  let vadOpen = false;
  let meter: LevelMeter | null = null;
  let meterFor: MediaStreamTrack | null = null;
  let meterToken = 0;
  let watched: LocalAudioTrack | undefined;

  const pushGate = () => {
    const p = prefs();
    controller.setGate({
      inputMode: p.inputMode,
      pttActive: useVoiceSession.getState().pttActive,
      vadGate: p.vadGate,
      vadOpen,
    });
  };
  const stopMeter = () => {
    meterToken += 1;
    meter?.stop();
    meter = null;
    meterFor = null;
  };
  const evaluate = () => {
    const p = prefs();
    const track = micTrack(room);
    if (watched !== track) {
      watched?.off(TrackEvent.Restarted, evaluate);
      track?.on(TrackEvent.Restarted, evaluate);
      watched = track;
    }
    const wanted = p.inputMode === 'voice' && p.vadGate && isLive() && track ? track.mediaStreamTrack : null;
    if (wanted === meterFor) return;
    stopMeter();
    if (wanted === null) {
      hysteresis.reset();
      if (vadOpen) {
        vadOpen = false;
        pushGate();
      }
      return;
    }
    meterFor = wanted;
    const token = meterToken;
    createLevelMeter(wanted).then(
      (created) => {
        if (token !== meterToken) {
          created.stop();
          return;
        }
        meter = created;
        created.subscribe((db) => {
          const open = hysteresis.update(db, prefs().vadThresholdDb, performance.now());
          if (open === vadOpen) return;
          vadOpen = open;
          pushGate();
        });
      },
      () => {
        if (token !== meterToken) return;
        // No Web Audio here: fail open rather than never transmitting.
        vadOpen = true;
        pushGate();
      },
    );
  };

  const unsubscribePrefs = useVoicePrefs.subscribe((s, prev) => {
    if (s.prefs === prev.prefs) return;
    pushGate();
    evaluate();
  });
  const unsubscribeSession = useVoiceSession.subscribe((s, prev) => {
    if (s.pttActive !== prev.pttActive) pushGate();
    if (s.state !== prev.state) evaluate();
  });
  room.on(RoomEvent.LocalTrackPublished, evaluate).on(RoomEvent.LocalTrackUnpublished, evaluate);
  pushGate();
  evaluate();

  return () => {
    unsubscribePrefs();
    unsubscribeSession();
    room.off(RoomEvent.LocalTrackPublished, evaluate).off(RoomEvent.LocalTrackUnpublished, evaluate);
    watched?.off(TrackEvent.Restarted, evaluate);
    stopMeter();
  };
}

function sameKeys(a: Record<string, true>, ids: readonly string[]): boolean {
  const keys = Object.keys(a);
  return keys.length === ids.length && ids.every((id) => a[id] === true);
}

/** `voice:state` over the socket (voice/stateSender.ts); `resend` re-sends after a rate limit. */
function voiceStateSender(socket: HearthSocket, resend: () => void): (payload: VoiceStatePayload) => void {
  return createVoiceStateSender(
    {
      connected: () => socket.connected,
      emit: (payload, ack) => {
        // Socket.IO passes `null` as `err` on an ack (its type says `Error`), an Error on a timeout.
        socket
          .timeout(VOICE_STATE_ACK_TIMEOUT_MS)
          .emit('voice:state', payload, (err: Error | null, res: Ack<null> | undefined) => {
            ack(err === null ? res : undefined);
          });
      },
    },
    resend,
  );
}

function createController(room: Room, socket: HearthSocket, devices: ResolvedDevices): VoiceController {
  const lp = () => room.localParticipant;
  // The sender's rate-limit retry re-sends the controller's current state (created just below).
  let controller: VoiceController | null = null;
  const sendState = voiceStateSender(socket, () => {
    controller?.syncState();
  });
  controller = createVoiceController<LocalTrackPublication>({
    room: {
      connect: (url, token) => room.connect(url, token),
      disconnect: () => room.disconnect(),
      setMicrophoneEnabled: async (enabled, transmit) => {
        const published = micTrack(room);
        if (enabled && !transmit && published) {
          // Unmuting while the gate is closed: the mic stays muted until push-to-talk or voice
          // activity opens it.
          await published.mute();
          return;
        }
        try {
          await lp().setMicrophoneEnabled(enabled);
        } catch (error) {
          // The chosen mic (asked for `exact`ly) is gone: publish the system default instead.
          if (!enabled || !isMissingDevice(error)) throw error;
          await lp().setMicrophoneEnabled(true, withDefaultMic(room.options.audioCaptureDefaults ?? {}));
        }
        // A first publish while the gate is closed: mute it straight away.
        if (enabled && !transmit) await micTrack(room)?.mute();
      },
      setMicGate: async (open) => {
        const track = micTrack(room);
        if (!track) return;
        if (open) await track.unmute();
        else await track.mute();
      },
      restartMic: async (constraints) => {
        // Our constraints (voice/roomOptions.ts micConstraints) hold plain booleans for the
        // processing flags, which is all LiveKit's capture options add over MediaTrackConstraints.
        const track = micTrack(room);
        if (!track) return;
        try {
          await track.restartTrack(constraints as AudioCaptureOptions);
        } catch (error) {
          // The chosen mic went away between listing and capture: keep talking on the default.
          if (!isMissingDevice(error)) throw error;
          await track.restartTrack(withDefaultMic(constraints) as AudioCaptureOptions);
        }
      },
      // Presets: CONTRACTS B.6b rule 3 (camera at the chosen quality and device, 30 fps, with
      // LiveKit's default simulcast).
      setCameraEnabled: async (enabled) => {
        const pub = await lp().setCameraEnabled(
          enabled,
          enabled ? cameraCaptureOptions(useVoicePrefs.getState().prefs, devices.videoinput) : undefined,
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
    fetchToken: (channelId, signal) => fetchVoiceToken(channelId, signal),
    sendState,
    notify: (message) => {
      useNoticeStore.getState().setNotice(message);
    },
    alert: (message) => {
      usePageAlertStore.getState().show(message);
    },
  });
  return controller;
}

export interface VoiceEngine {
  /** The app's one LiveKit room (adaptive stream, dynacast), shared with the video stage. */
  room: Room;
  controller: VoiceController;
  /** The devices in use per kind (kept up to date by the device sync). */
  devices: ResolvedDevices;
  actions: EngineVoiceActions;
  /** `window.__hearthDebug.voice()` for this room (e2e builds only, else `null`). */
  debug: (() => Promise<HearthVoiceDebug>) | null;
}

/** Creates the room, its controller and the voice actions (once per signed-in session). */
export function createVoiceEngine(socket: HearthSocket): VoiceEngine {
  // Capture options from the voice prefs (docs/plans/devices.md); the defaults equal LiveKit's own.
  const prefs = useVoicePrefs.getState().prefs;
  const devices = preferredDevices(prefs);
  const room = new Room({ adaptiveStream: true, dynacast: true, ...roomOptionsFromPrefs(prefs, devices) });
  const controller = createController(room, socket, devices);
  const actions: EngineVoiceActions = {
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
  };
  const debug = import.meta.env.VITE_E2E === 'true' ? () => voiceDebug(room) : null;
  return { room, controller, devices, actions, debug };
}

/**
 * The engine's live wiring (docs/plans/phase-6.md, "Key decisions → Web"): plays remote audio
 * (microphones and screen-share audio) through `RoomAudioRenderer` (muted while deafened), applies
 * saved per-user volumes to both, tracks active speakers and blocked playback, watches our camera
 * and screen (phase 7), and keeps the server's view of our mute/deafen/camera/screen state in sync.
 * Mounted by VoiceProvider for as long as the signed-in layout; VoiceProvider leaves the room on
 * unmount, so these effects only attach and detach listeners (safe to run twice in StrictMode while
 * a join is in progress).
 */
export function VoiceEngineView({ engine }: { engine: VoiceEngine }) {
  const { room, controller, devices } = engine;
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

  // Devices, processing and camera quality follow the prefs live; lost devices fall back to default.
  useEffect(
    () =>
      startDeviceSync({
        room,
        controller,
        devices,
        notify: (message) => {
          useNoticeStore.getState().setNotice(message);
        },
      }),
    [room, controller, devices],
  );

  // The local gate (CONTRACTS B.12 rule 2): push-to-talk or voice activity, applied by the controller.
  useEffect(() => startLocalGate(room, controller), [room, controller]);

  // Microphones and screen-share audio; deafen mutes both.
  return <RoomAudioRenderer room={room} muted={deafened} />;
}
