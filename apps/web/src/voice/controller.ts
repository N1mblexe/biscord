import type { VoiceStatePayload, VoiceTokenResponse } from '@hearth/shared';
import { toggleDeafen, toggleMute, useVoiceSession, type MicState } from './session';

/** The part of a LiveKit `Room` the controller drives (VoiceProvider adapts the real one). */
export interface VoiceRoomPort {
  connect: (url: string, token: string) => Promise<void>;
  /** Leaves the room; resolves once disconnected. Harmless when not connected. */
  disconnect: () => Promise<void>;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
}

export interface VoiceControllerDeps {
  room: VoiceRoomPort;
  /** Row 29. */
  fetchToken: (channelId: string) => Promise<VoiceTokenResponse>;
  /** Emits `voice:state` (best-effort). */
  sendState: (payload: VoiceStatePayload) => void;
  /** Shows a message to the user (join failed, mic unavailable, dropped from voice). */
  notify: (message: string) => void;
}

export interface VoiceController {
  /** Joins `channelId`, leaving the current room first. A no-op when already in it. */
  join: (channelId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /** Re-sends our state (the server lists us with a different mute/deafen state). */
  syncState: () => void;
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
} as const;

const session = () => useVoiceSession.getState();

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
export function createVoiceController({
  room,
  fetchToken,
  sendState,
  notify,
}: VoiceControllerDeps): VoiceController {
  let generation = 0;
  /** Mic changes run one at a time, each applying the latest desired state. */
  let micQueue: Promise<void> = Promise.resolve();

  const send = () => {
    const s = session();
    if (!isLive() || s.channelId === null) return;
    sendState({
      channelId: s.channelId,
      selfMute: s.micMuted,
      selfDeaf: s.deafened,
      camera: false,
      screen: false,
    });
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
      session().set({ channelId, roomName: null, state: 'connecting', speaking: {}, levelSpeaking: {} });

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
      });
      await room.disconnect().catch(() => undefined);
    },

    toggleMute: () => {
      setMic(toggleMute(session()));
    },

    toggleDeafen: () => {
      setMic(toggleDeafen(session()));
    },

    syncState: send,

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
      });
      notify(VOICE_MESSAGES.dropped);
    },
  };
}
