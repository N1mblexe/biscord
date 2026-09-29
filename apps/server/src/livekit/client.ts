import { ParticipantInfo_State, RoomServiceClient, ServerError, type TrackSource } from 'livekit-server-sdk';
import type { Env } from '../env.js';

/** A track a participant has published (`ParticipantInfo.tracks[]`); muted tracks are still published. */
export interface BackendTrack {
  source: TrackSource;
  muted: boolean;
}

/**
 * A participant as the server needs it: identity (= Hearth user id), connection sid, join time and the
 * tracks it publishes (B.6b rule 1: the reconcile checks the client's `camera`/`screen` flags against them).
 */
export interface BackendParticipant {
  identity: string;
  sid: string;
  /** Unix ms; 0 when LiveKit didn't report it. */
  joinedAtMs: number;
  tracks: BackendTrack[];
}

/**
 * The only LiveKit operations the server uses (B.6: moderation and reconcile go through the server's
 * `RoomServiceClient`). Methods reject with the SDK's `ServerError` on an HTTP error; callers decide whether a
 * 404 counts as success (`isNotFoundError`). Tests inject a fake through `buildApp({ voiceBackend })`.
 */
export interface VoiceBackend {
  /** Names of every active room on the LiveKit server (including rooms of other Hearth databases). */
  listRooms(): Promise<string[]>;
  /** Connected participants of `room` (disconnected ones are left out). */
  listParticipants(room: string): Promise<BackendParticipant[]>;
  removeParticipant(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
}

/** Seconds; every server→LiveKit call gives up after this. The health probe uses its own 2 s timeout. */
const REQUEST_TIMEOUT_SECONDS = 5;

/** `RoomServiceClient` against `LIVEKIT_URL` (an http(s) URL, never ws). */
export function createLiveKitBackend(
  env: Pick<Env, 'LIVEKIT_URL' | 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET'>,
): VoiceBackend {
  const client = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    requestTimeout: REQUEST_TIMEOUT_SECONDS,
    // Region failover only applies to LiveKit Cloud; a self-hosted server has nowhere to fail over to.
    failover: false,
  });
  return {
    async listRooms() {
      return (await client.listRooms()).map((room) => room.name);
    },
    async listParticipants(room) {
      const participants = await client.listParticipants(room);
      return participants
        .filter((p) => p.state !== ParticipantInfo_State.DISCONNECTED)
        .map((p) => ({
          identity: p.identity,
          sid: p.sid,
          joinedAtMs: p.joinedAtMs > 0n ? Number(p.joinedAtMs) : Number(p.joinedAt) * 1000,
          tracks: p.tracks.map((t) => ({ source: t.source, muted: t.muted })),
        }));
    },
    removeParticipant: (room, identity) => client.removeParticipant(room, identity),
    deleteRoom: (room) => client.deleteRoom(room),
  };
}

/** A LiveKit "not found" (unknown room or participant): B.6a counts it as success for removals. */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ServerError && err.status === 404;
}

/** Awaits `operation`, treating a LiveKit 404 as success. */
export async function ignoreNotFound(operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

/** Rejects with an error after `ms` unless `promise` settles first. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
