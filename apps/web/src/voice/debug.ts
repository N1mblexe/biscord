import {
  ConnectionState,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client';
import { useVoiceSession } from './session';
import { volumeFor } from './volume';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Sum of inbound-rtp audio `bytesReceived` in a track's stats report. */
export function inboundAudioBytes(report: RTCStatsReport | undefined): number {
  let bytes = 0;
  report?.forEach((stat: unknown) => {
    if (!isRecord(stat) || stat.type !== 'inbound-rtp') return;
    if (stat.kind !== undefined && stat.kind !== 'audio') return;
    if (typeof stat.bytesReceived === 'number') bytes += stat.bytesReceived;
  });
  return bytes;
}

/**
 * A remote's audio is muted in local playback when its microphone publication is disabled on our side.
 * `RoomAudioRenderer muted` (deafen) does exactly that via `RemoteTrackPublication.setEnabled(false)`, so
 * this reads the real track state rather than our own `deafened` flag.
 */
export function remotePlaybackMuted(pub: Pick<RemoteTrackPublication, 'isEnabled'> | undefined): boolean {
  return pub !== undefined && !pub.isEnabled;
}

/** All remote audio is muted in local playback: at least one remote, and every one of them muted. */
export function allPlaybackMuted(remotes: readonly Pick<HearthVoiceDebugRemote, 'muted'>[]): boolean {
  return remotes.length > 0 && remotes.every((r) => r.muted);
}

async function remoteDebug(p: RemoteParticipant): Promise<HearthVoiceDebugRemote> {
  const pub = p.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track;
  const audioSubscribed = pub?.isSubscribed === true && track !== undefined;
  const report = track ? await track.getRTCStatsReport().catch(() => undefined) : undefined;
  return {
    identity: p.identity,
    audioSubscribed,
    audioBytesReceived: inboundAudioBytes(report),
    volume: p.getVolume() ?? volumeFor(p.identity),
    muted: remotePlaybackMuted(pub),
    remoteMicMuted: pub?.isMuted ?? true,
  };
}

async function voiceDebug(room: Room): Promise<HearthVoiceDebug> {
  const s = useVoiceSession.getState();
  const inRoom = room.state !== ConnectionState.Disconnected;
  const remotes = await Promise.all([...room.remoteParticipants.values()].map((p) => remoteDebug(p)));
  return {
    state: room.state,
    roomName: inRoom && room.name !== '' ? room.name : null,
    localIdentity: inRoom && room.localParticipant.identity !== '' ? room.localParticipant.identity : null,
    channelId: s.channelId,
    playbackMuted: allPlaybackMuted(remotes),
    micMuted: s.micMuted,
    deafened: s.deafened,
    canPlaybackAudio: room.canPlaybackAudio,
    activeSpeakers: room.activeSpeakers.map((p) => p.identity),
    speaking: Object.keys({ ...s.speaking, ...s.levelSpeaking }).sort(),
    remotes,
  };
}

/**
 * E2E builds only (`VITE_E2E=true`): `window.__hearthDebug.voice()` reports the LiveKit room as the
 * voice specs need it (connection state, subscriptions, received audio bytes, local playback mute).
 * In every other build `import.meta.env.VITE_E2E` is replaced statically, so this is dead code.
 */
export function installVoiceDebug(room: Room): () => void {
  if (import.meta.env.VITE_E2E !== 'true') return () => undefined;
  const hook = { voice: () => voiceDebug(room) };
  window.__hearthDebug = hook;
  return () => {
    if (window.__hearthDebug === hook) delete window.__hearthDebug;
  };
}
