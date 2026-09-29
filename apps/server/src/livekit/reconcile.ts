import type { FastifyBaseLogger } from 'fastify';
import { parseVoiceRoomName, Uuid, voiceRoomName } from '@hearth/shared';
import { TrackSource } from 'livekit-server-sdk';
import type { Db } from '../db/client.js';
import { loggableError } from '../lib/errors.js';
import type {
  DesiredVoiceState,
  ObservedParticipant,
  PublishedMedia,
  VoiceState,
} from '../realtime/voice-state.js';
import { listVoiceChannelIds } from '../services/channels.js';
import {
  ignoreNotFound,
  isNotFoundError,
  type BackendParticipant,
  type BackendTrack,
  type VoiceBackend,
} from './client.js';
import type { LiveKitHealth } from './health.js';

export interface ReconcileDeps {
  db: Db;
  backend: VoiceBackend;
  voice: VoiceState;
  health: LiveKitHealth;
  log: FastifyBaseLogger;
}

export interface Reconciler {
  /** Runs a pass after the one in progress, if any (passes never overlap). Never rejects. */
  runNow(): Promise<void>;
  /** A pass now (not awaited), then one every `intervalMs`; a tick while a pass runs is skipped. */
  start(intervalMs: number): void;
  /** Stops the timer and waits for a pass in progress (so the DB pool isn't closed under it). */
  stop(): Promise<void>;
}

/**
 * B.6b rule 1: which of camera / screen share the participant actually publishes. A muted track is still
 * published. Screen-share audio alone is not a screen share.
 */
export function publishedMedia(tracks: readonly BackendTrack[]): PublishedMedia {
  return {
    camera: tracks.some((t) => t.source === TrackSource.CAMERA),
    screen: tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
  };
}

function toObserved(p: BackendParticipant): ObservedParticipant | null {
  // Only Hearth users (identity = user id) count; anything else in the room is not ours to track.
  if (!Uuid.safeParse(p.identity).success) return null;
  return {
    userId: p.identity.toLowerCase(),
    sid: p.sid,
    joinedAt: new Date(p.joinedAtMs > 0 ? p.joinedAtMs : Date.now()),
    media: publishedMedia(p.tracks),
  };
}

/**
 * One reconcile pass (B.6 / B.6a rule 4): `listRooms` → the Hearth rooms of **this** DB → `listParticipants`
 * each → diff against memory, emitting joined/left. Memberships changed while LiveKit was being listed are
 * left alone (the webhooks that changed them are newer). A user LiveKit reports in two rooms keeps the most
 * recent join and is removed from the other (B.6a rule 5). `camera`/`screen` flags without a matching
 * published track are cleared (B.6b rule 1), unless the client set them after the pass began. A failed
 * listing changes nothing.
 */
async function reconcileOnce({ db, backend, voice, health, log }: ReconcileDeps): Promise<void> {
  const since = voice.mark();
  let roomNames: string[];
  try {
    roomNames = await backend.listRooms();
    health.record('ok');
  } catch (err) {
    health.record('down');
    log.warn({ err: loggableError(err) }, 'voice reconcile: listRooms failed');
    return;
  }
  const candidates = [...new Set(roomNames.flatMap((name) => parseVoiceRoomName(name)?.toLowerCase() ?? []))];
  const own = await listVoiceChannelIds(db, candidates);

  const listed = new Map<string, ObservedParticipant[]>();
  for (const channelId of own) {
    try {
      const participants = await backend.listParticipants(voiceRoomName(channelId));
      listed.set(
        channelId,
        participants.flatMap((p) => toObserved(p) ?? []),
      );
    } catch (err) {
      // The room closed since `listRooms`: nobody is in it.
      if (isNotFoundError(err)) listed.set(channelId, []);
      else {
        log.warn({ err: loggableError(err), channelId }, 'voice reconcile: listParticipants failed');
        return;
      }
    }
  }

  // Newest join per user; the others are extra rooms to leave.
  const latest = new Map<string, { channelId: string; participant: ObservedParticipant }>();
  const extras: { channelId: string; userId: string }[] = [];
  for (const [channelId, participants] of listed) {
    for (const participant of participants) {
      const seen = latest.get(participant.userId);
      if (seen === undefined) {
        latest.set(participant.userId, { channelId, participant });
      } else if (participant.joinedAt.getTime() > seen.participant.joinedAt.getTime()) {
        extras.push({ channelId: seen.channelId, userId: participant.userId });
        latest.set(participant.userId, { channelId, participant });
      } else if (channelId !== seen.channelId) {
        extras.push({ channelId, userId: participant.userId });
      }
    }
  }

  await voice.exclusive(async () => {
    // Re-check under the lock: a channel deleted (or a test reset) since the listing is no longer ours.
    const stillOwn = new Set(await listVoiceChannelIds(db, [...listed.keys()]));
    const desired: DesiredVoiceState = new Map();
    for (const { channelId, participant } of latest.values()) {
      if (!stillOwn.has(channelId)) continue;
      let users = desired.get(channelId);
      if (users === undefined) {
        users = new Map();
        desired.set(channelId, users);
      }
      users.set(participant.userId, participant);
    }
    voice.reconcile(desired, since);
  });

  for (const { channelId, userId } of extras) {
    try {
      await ignoreNotFound(backend.removeParticipant(voiceRoomName(channelId), userId));
    } catch (err) {
      log.warn({ err: loggableError(err), channelId, userId }, 'voice reconcile: removeParticipant failed');
    }
  }
}

export function createReconciler(deps: ReconcileDeps): Reconciler {
  let current: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const launch = (after: Promise<void> | null): Promise<void> => {
    const run: Promise<void> = (after ?? Promise.resolve())
      .then(() => reconcileOnce(deps))
      .catch((err: unknown) => {
        deps.log.error({ err: loggableError(err) }, 'voice reconcile failed');
      })
      .finally(() => {
        if (current === run) current = null;
      });
    current = run;
    return run;
  };

  return {
    runNow: () => launch(current),
    start(intervalMs) {
      void launch(current);
      timer = setInterval(() => {
        if (current === null) void launch(null);
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      while (current !== null) await current;
    },
  };
}
