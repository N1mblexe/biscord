import type { FastifyInstance } from 'fastify';
import { parseVoiceRoomName, Uuid, voiceRoomName } from '@hearth/shared';
import type { FastifyBaseLogger } from 'fastify';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import type { Db } from '../db/client.js';
import { AppError, loggableError } from '../lib/errors.js';
import { ignoreNotFound, type VoiceBackend } from '../livekit/client.js';
import type { VoiceState } from '../realtime/voice-state.js';
import { listVoiceChannelIds } from '../services/channels.js';
import { listDeactivatedUserIds } from '../services/users.js';
import type { RouteDeps } from './deps.js';

export const WEBHOOK_PATH = '/api/livekit/webhook';
export const WEBHOOK_CONTENT_TYPE = 'application/webhook+json';
const WEBHOOK_BODY_LIMIT = 1024 * 1024;

const HANDLED = new Set([
  'participant_joined',
  'participant_left',
  'participant_connection_aborted',
  'room_finished',
]);

/**
 * `DisconnectReason`s (livekit protocol; the enum isn't re-exported by the server SDK) that end the
 * membership at once: the user left on purpose, was removed, or the room is gone. Any other reason (a lost
 * or replaced connection, a timeout, unknown) may be followed by a reconnect, so the leave waits out the
 * rejoin grace (B.9 rule 8).
 */
const FINAL_DISCONNECT_REASONS: ReadonlySet<number> = new Set([
  1, // CLIENT_INITIATED
  4, // PARTICIPANT_REMOVED
  5, // ROOM_DELETED
  10, // ROOM_CLOSED
]);

function joinedAtOf(event: WebhookEvent): Date {
  const p = event.participant;
  const ms = p === undefined ? 0 : p.joinedAtMs > 0n ? Number(p.joinedAtMs) : Number(p.joinedAt) * 1000;
  return new Date(ms > 0 ? ms : Date.now());
}

interface ApplyDeps {
  db: Db;
  voice: VoiceState;
  voiceBackend: VoiceBackend;
  log: FastifyBaseLogger;
}

/**
 * Applies one verified event. Rooms that aren't a voice channel of **this** DB are ignored (B.6a rule 3).
 * A deactivated user's join (a token minted before the deactivation is valid for up to 10 min) is not
 * tracked; the participant is removed from the room instead (fire-and-forget; the reconcile retries).
 */
async function applyEvent({ db, voice, voiceBackend, log }: ApplyDeps, event: WebhookEvent): Promise<void> {
  if (!HANDLED.has(event.event)) return;
  const channelId = parseVoiceRoomName(event.room?.name ?? '')?.toLowerCase();
  if (channelId === undefined) return;
  if ((await listVoiceChannelIds(db, [channelId])).length === 0) return;

  if (event.event === 'room_finished') {
    voice.roomFinished(channelId);
    return;
  }
  const participant = event.participant;
  if (participant === undefined || !Uuid.safeParse(participant.identity).success) return;
  const userId = participant.identity.toLowerCase();
  if (event.event === 'participant_joined') {
    if ((await listDeactivatedUserIds(db, [userId])).length > 0) {
      ignoreNotFound(voiceBackend.removeParticipant(voiceRoomName(channelId), userId)).catch(
        (err: unknown) => {
          log.warn(
            { err: loggableError(err), channelId, userId },
            'webhook: removing a deactivated user failed',
          );
        },
      );
      return;
    }
    voice.participantJoined(channelId, { userId, sid: participant.sid, joinedAt: joinedAtOf(event) });
  } else {
    // `participant_connection_aborted` counts as left.
    const graceful = !FINAL_DISCONNECT_REASONS.has(participant.disconnectReason);
    voice.participantLeft(channelId, userId, participant.sid, graceful);
  }
}

/**
 * CONTRACTS B.4 row 30 / B.6a rule 3. The raw body (a parser scoped to this route returns it unparsed) and
 * the `Authorization` JWT go to `WebhookReceiver`, which checks the signature and the body's sha256; any
 * failure is 401. Handling is idempotent: repeated event ids are no-ops, participants are keyed by sid.
 * CSRF-exempt (lib/csrf.ts).
 */
export function registerLiveKitWebhookRoute(
  app: FastifyInstance,
  { db, env, voice, voiceBackend }: Pick<RouteDeps, 'db' | 'env' | 'voice' | 'voiceBackend'>,
): void {
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

  void app.register((scope, _opts, done) => {
    // Only the raw webhook type: without the inherited JSON / text parsers, any other type (including
    // `application/json` and `text/plain`) is refused by Fastify with 415 before the handler runs.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      WEBHOOK_CONTENT_TYPE,
      { parseAs: 'string', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );

    scope.post(WEBHOOK_PATH, async (request, reply) => {
      const body = request.body;
      // Belt and braces: e.g. a request without a body (or without a Content-Type) never reaches the parser.
      if (typeof body !== 'string') {
        throw new AppError('UNSUPPORTED_MEDIA', `Expected ${WEBHOOK_CONTENT_TYPE}`);
      }
      const header = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      let event: WebhookEvent;
      try {
        event = await receiver.receive(body, header);
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'rejected LiveKit webhook',
        );
        throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature');
      }

      // A failure is not remembered (→ 500), so LiveKit's retry, or a copy already waiting, handles it.
      const outcome = await voice.processEvent(event.id, () =>
        voice.exclusive(() => applyEvent({ db, voice, voiceBackend, log: request.log }, event)),
      );
      if (outcome === 'duplicate') {
        request.log.debug({ eventId: event.id }, 'duplicate LiveKit webhook ignored');
      }
      return reply.status(200).send();
    });
    done();
  });
}
