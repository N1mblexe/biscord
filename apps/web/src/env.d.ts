/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `'true'` only in the Playwright dev-server build (e2e/playwright.config.ts); enables the event log and `window.__hearthDebug`. */
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** One server→client socket event, as recorded by the e2e-only event log (src/lib/eventLog.ts). */
interface HearthEventLogEntry {
  event: string;
  /** The channel the event is about, or `null` for events without one (e.g. `channels:reordered`). */
  channelId: string | null;
}

/** One remote participant in `window.__hearthDebug.voice()` (src/voice/debug.ts). */
interface HearthVoiceDebugRemote {
  /** LiveKit identity = the Hearth user id. */
  identity: string;
  /** The remote's microphone track is subscribed. */
  audioSubscribed: boolean;
  /** inbound-rtp `bytesReceived` of that track (0 when not subscribed). */
  audioBytesReceived: number;
  /** Local playback volume for this remote (0–1). */
  volume: number;
  /** This remote's microphone publication is disabled in local playback (what deafen does). */
  muted: boolean;
  /** The remote muted their own microphone. */
  remoteMicMuted: boolean;
  /** This remote's videos (empty when none); an unpublished or stopped video is not listed. */
  video: HearthVoiceDebugVideo[];
}

/** One remote video in `window.__hearthDebug.voice()`: a published, unmuted camera or screen share. */
interface HearthVoiceDebugVideo {
  source: 'camera' | 'screen_share';
  /** We are subscribed and have the track. */
  subscribed: boolean;
  /** `videoWidth` of the `<video>` element the track is attached to (0 when not attached). */
  videoWidth: number;
  /** `framesDecoded` from the track's `getReceiverStats()` (0 when unavailable). */
  framesDecoded: number;
}

/** `window.__hearthDebug.voice()` (e2e builds only). */
interface HearthVoiceDebug {
  /** LiveKit connection state: `disconnected`, `connecting`, `connected`, `reconnecting`, … */
  state: string;
  /** `voice_<channelId>` while in a room, else `null`. */
  roomName: string | null;
  /** Our LiveKit identity (user id) while in a room, else `null`. */
  localIdentity: string | null;
  /** The voice channel we are in or joining (our own session state), else `null`. */
  channelId: string | null;
  /** Every remote's audio is muted in local playback (false with no remotes); derived from track state. */
  playbackMuted: boolean;
  micMuted: boolean;
  deafened: boolean;
  /** False when the browser blocks audio playback (autoplay). */
  canPlaybackAudio: boolean;
  /** Identities in LiveKit's `room.activeSpeakers`. */
  activeSpeakers: string[];
  /** Identities the sidebar shows as speaking (`data-speaking="true"`). */
  speaking: string[];
  remotes: HearthVoiceDebugRemote[];
  /** What this page publishes: camera on, screen shared. */
  local: { camera: boolean; screen: boolean };
}

interface Window {
  /** Present only when `VITE_E2E === 'true'`. */
  __hearthEvents?: HearthEventLogEntry[];
  /** Present only when `VITE_E2E === 'true'` (src/voice/debug.ts). */
  __hearthDebug?: {
    voice: () => Promise<HearthVoiceDebug>;
  };
}
