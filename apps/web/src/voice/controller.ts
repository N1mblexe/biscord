import type { VoiceStatePayload, VoiceTokenResponse } from '@hearth/shared';
import {
  MEDIA_OFF,
  toggleDeafen,
  toggleMute,
  useVoiceSession,
  type MicState,
  type PublishState,
} from './session';

/** What LiveKit really publishes for our two video sources. */
export interface PublishedVideo {
  camera: boolean;
  screen: boolean;
}

/**
 * The part of a LiveKit `Room` the controller drives (VoiceProvider adapts the real one). `P` is what a
 * start published: `LocalTrackPublication`s in the real port.
 */
export interface VoiceRoomPort<P = unknown> {
  connect: (url: string, token: string) => Promise<void>;
  /** Leaves the room; resolves once disconnected. Harmless when not connected. */
  disconnect: () => Promise<void>;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Publishes (720p, simulcast) or stops our camera; a start resolves with what it published. Rejects
   * when the camera is unavailable or denied.
   */
  setCameraEnabled: (enabled: boolean) => Promise<readonly P[]>;
  /**
   * Opens the browser's picker and publishes the screen (1080p30, no simulcast), with tab audio when
   * `withAudio` and the browser provides it, resolving with what it published (screen and its
   * audio); or stops sharing, removing both. Rejects when cancelled or denied.
   */
  setScreenShareEnabled: (enabled: boolean, withAudio: boolean) => Promise<readonly P[]>;
  /** Unpublishes what a start published and stops its capture (a start that finished too late). */
  unpublish: (published: readonly P[]) => Promise<void>;
  /**
   * What LiveKit really publishes right now, or `null` while the room isn't connected (a reconnect
   * unpublishes and republishes everything, so the answer would be wrong).
   */
  publishedVideo: () => PublishedVideo | null;
}

/** The flags the server lists us with (`VoiceParticipant`). */
export interface ServerVoiceView {
  selfMute: boolean;
  selfDeaf: boolean;
  camera: boolean;
  screen: boolean;
}

/** Our two video sources. */
export type LocalVideoKind = 'camera' | 'screen';

export interface VoiceControllerDeps<P = unknown> {
  room: VoiceRoomPort<P>;
  /** Row 29. */
  fetchToken: (channelId: string) => Promise<VoiceTokenResponse>;
  /** Emits `voice:state` (best-effort). */
  sendState: (payload: VoiceStatePayload) => void;
  /** Shows a message to the user (join failed, mic unavailable, dropped from voice). */
  notify: (message: string) => void;
  /** Shows the page's alert (camera or screen share failed). */
  alert: (message: string) => void;
}

export interface VoiceController {
  /** Joins `channelId`, leaving the current room first. A no-op when already in it. */
  join: (channelId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /**
   * The server lists us as `server`: first align camera/screen with what LiveKit really publishes
   * (never re-assert a flag the server's reconcile rightly cleared), then re-send our state if it
   * still differs. Without `server`, just re-sends.
   */
  syncState: (server?: ServerVoiceView) => void;
  /** **Camera** / **Stop camera**. Ignored while not in a room or while a change is in progress. */
  toggleCamera: () => void;
  /** **Share screen** / **Stop sharing** (tab audio per the **Share tab audio** checkbox). */
  toggleScreen: () => void;
  /**
   * Our camera or screen stopped without us asking (the browser's own "Stop sharing", a camera
   * that went away): the button goes back to off, the flags follow, and the same stop as the button
   * runs (so screen-share audio goes too). A no-op unless it was on or starting.
   */
  onLocalVideoEnded: (kind: LocalVideoKind) => void;
  /** Room events. */
  onReconnecting: () => void;
  onReconnected: () => void;
  /** The room disconnected; only acted on when we didn't cause it (dropped, removed, room deleted). */
  onDisconnected: () => void;
}

export const VOICE_MESSAGES = {
  joinFailed: "Couldn't join the voice channel. Try again.",
  micUnavailable: 'Microphone unavailable: check the browser permission. You joined muted.',
  dropped: 'You were disconnected from voice.',
  cameraBlocked: 'Camera is unavailable or blocked',
  screenBlocked: 'Screen share was cancelled or blocked',
} as const;

const session = () => useVoiceSession.getState();

const VIDEO_KINDS = ['camera', 'screen'] as const satisfies readonly LocalVideoKind[];

function isLive(): boolean {
  const { state } = session();
  return state === 'connected' || state === 'reconnecting';
}

/**
 * One voice session at a time (CONTRACTS B.6a rule 5): join = fetch token → leave the old room →
 * connect → enable the mic (unless muted) → send `voice:state`. Every join or leave bumps a
 * generation, so a join overtaken by another join or a leave stops at its next step (the newer
 * operation owns the room from then on).
 */
export function createVoiceController<P>({
  room,
  fetchToken,
  sendState,
  notify,
  alert,
}: VoiceControllerDeps<P>): VoiceController {
  let generation = 0;
  /** Mic changes run one at a time, each applying the latest desired state. */
  let micQueue: Promise<void> = Promise.resolve();

  const setVideo = (kind: LocalVideoKind, state: PublishState) => {
    session().set(kind === 'camera' ? { camera: state } : { screen: state });
  };

  const enableVideo = (kind: LocalVideoKind, enabled: boolean): Promise<readonly P[]> =>
    kind === 'camera'
      ? room.setCameraEnabled(enabled)
      : room.setScreenShareEnabled(enabled, session().shareTabAudio);

  /** Kinds whose stop is still running (LiveKit may still list them as published meanwhile). */
  const stopsInFlight = new Set<LocalVideoKind>();

  /** The button's stop: unpublishes (for the screen, its audio too); failures are ignored. */
  const stopVideo = async (kind: LocalVideoKind): Promise<void> => {
    stopsInFlight.add(kind);
    try {
      await enableVideo(kind, false);
    } catch {
      // Already gone, or the room is closing: nothing left to stop.
    } finally {
      stopsInFlight.delete(kind);
    }
  };

  /**
   * Aligns settled camera/screen states with what LiveKit really publishes (skipped while it isn't
   * connected): `on` without a publication turns off, and anything published while we say `off` is
   * stopped (never publish while the UI says off). `starting`/`stopping` are in flux and left alone.
   */
  const reconcileVideo = () => {
    if (session().state !== 'connected') return;
    const real = room.publishedVideo();
    if (real === null) return;
    for (const kind of VIDEO_KINDS) {
      const state = session()[kind];
      if (state === 'on' && !real[kind]) {
        setVideo(kind, 'off');
        void stopVideo(kind);
      } else if (state === 'off' && real[kind] && !stopsInFlight.has(kind)) {
        void stopVideo(kind);
      }
    }
  };

  const payload = (): VoiceStatePayload | null => {
    const s = session();
    if (!isLive() || s.channelId === null) return null;
    return {
      channelId: s.channelId,
      selfMute: s.micMuted,
      selfDeaf: s.deafened,
      camera: s.camera === 'on',
      screen: s.screen === 'on',
    };
  };

  /** Sends our state, with the video flags checked against what LiveKit really publishes first. */
  const send = () => {
    reconcileVideo();
    const next = payload();
    if (next !== null) sendState(next);
  };

  /**
   * off → starting → on (flags sent) or back to off with the page alert; on → stopping (flags sent
   * at once) → off. Leaving or switching rooms while starting resets everything to off at once; a
   * start that still publishes afterwards (possibly into the next room) is unpublished and its
   * capture stopped, so nothing is sent or captured while the UI says off.
   */
  const toggleVideo = (kind: LocalVideoKind) => {
    if (!isLive()) return;
    const current = session()[kind];
    const gen = generation;
    if (current === 'off') {
      if (session().state !== 'connected') return;
      setVideo(kind, 'starting');
      enableVideo(kind, true).then(
        (published) => {
          if (gen !== generation || session()[kind] !== 'starting') {
            // We left or switched rooms, or it ended while starting: don't leave it published or
            // capturing.
            void room.unpublish(published).catch(() => undefined);
            return;
          }
          setVideo(kind, 'on');
          send();
        },
        () => {
          if (gen !== generation) return;
          setVideo(kind, 'off');
          alert(kind === 'camera' ? VOICE_MESSAGES.cameraBlocked : VOICE_MESSAGES.screenBlocked);
        },
      );
      return;
    }
    if (current === 'on') {
      setVideo(kind, 'stopping');
      send();
      void stopVideo(kind).then(() => {
        if (gen === generation && session()[kind] === 'stopping') setVideo(kind, 'off');
      });
    }
  };

  const applyMic = () => {
    const gen = generation;
    micQueue = micQueue.then(async () => {
      if (gen !== generation || !isLive()) return;
      const enable = !session().micMuted;
      try {
        await room.setMicrophoneEnabled(enable);
      } catch {
        if (gen !== generation || !enable) return;
        session().set({ micMuted: true, mutedBeforeDeafen: false });
        notify(VOICE_MESSAGES.micUnavailable);
        send();
      }
    });
  };

  const setMic = (next: MicState) => {
    session().set(next);
    if (!isLive()) return;
    applyMic();
    send();
  };

  const fail = async (gen: number) => {
    if (gen !== generation) return;
    generation += 1;
    session().set({
      channelId: null,
      roomName: null,
      state: 'disconnected',
      speaking: {},
      levelSpeaking: {},
      ...MEDIA_OFF,
    });
    notify(VOICE_MESSAGES.joinFailed);
    await room.disconnect().catch(() => undefined);
  };

  return {
    join: async (channelId) => {
      const current = session();
      if (current.channelId === channelId && current.state !== 'disconnected') return;
      generation += 1;
      const gen = generation;
      session().set({
        channelId,
        roomName: null,
        state: 'connecting',
        speaking: {},
        levelSpeaking: {},
        ...MEDIA_OFF,
      });

      let token: VoiceTokenResponse;
      try {
        token = await fetchToken(channelId);
      } catch {
        await fail(gen);
        return;
      }
      if (gen !== generation) return;

      // Leave the old room before joining the new one (one voice channel at a time).
      await room.disconnect().catch(() => undefined);
      if (gen !== generation) return;
      session().set({ roomName: token.roomName });

      try {
        await room.connect(token.url, token.token);
      } catch {
        await fail(gen);
        return;
      }
      if (gen !== generation) return;
      session().set({ state: 'connected' });
      applyMic();
      send();
    },

    leave: async () => {
      generation += 1;
      session().set({
        channelId: null,
        roomName: null,
        state: 'disconnected',
        speaking: {},
        levelSpeaking: {},
        ...MEDIA_OFF,
      });
      await room.disconnect().catch(() => undefined);
    },

    toggleMute: () => {
      setMic(toggleMute(session()));
    },

    toggleDeafen: () => {
      setMic(toggleDeafen(session()));
    },

    syncState: (server) => {
      // While LiveKit reconnects its publications are in flux; `onReconnected` re-sends the truth.
      if (room.publishedVideo() === null) return;
      reconcileVideo();
      const next = payload();
      if (next === null) return;
      if (
        server &&
        server.selfMute === next.selfMute &&
        server.selfDeaf === next.selfDeaf &&
        server.camera === next.camera &&
        server.screen === next.screen
      ) {
        return;
      }
      sendState(next);
    },

    toggleCamera: () => {
      toggleVideo('camera');
    },

    toggleScreen: () => {
      toggleVideo('screen');
    },

    onLocalVideoEnded: (kind) => {
      const current = session()[kind];
      if (current === 'on') {
        setVideo(kind, 'off');
        // The same stop as the button: for the screen this also removes its audio, which the
        // browser's own "Stop sharing" may leave published.
        void stopVideo(kind);
        send();
      } else if (current === 'starting') {
        // The start in flight sees this and unpublishes what it published instead of turning on.
        setVideo(kind, 'off');
      }
    },

    onReconnecting: () => {
      if (session().state === 'connected') session().set({ state: 'reconnecting' });
    },

    onReconnected: () => {
      if (session().state !== 'reconnecting') return;
      session().set({ state: 'connected' });
      send();
    },

    onDisconnected: () => {
      // While connecting, the join in progress owns the room (it disconnects the old one itself);
      // while disconnected, we left on purpose.
      if (!isLive()) return;
      generation += 1;
      session().set({
        channelId: null,
        roomName: null,
        state: 'disconnected',
        speaking: {},
        levelSpeaking: {},
        ...MEDIA_OFF,
      });
      notify(VOICE_MESSAGES.dropped);
    },
  };
}
