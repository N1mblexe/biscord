import type { FastifyInstance } from 'fastify';
import { parseVoiceRoomName, Uuid } from '@hearth/shared';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import type { Db } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import type { VoiceState } from '../realtime/voice-state.js';
import { listVoiceChannelIds } from '../services/channels.js';
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

function joinedAtOf(event: WebhookEvent): Date {
  const p = event.participant;
  const ms = p === undefined ? 0 : p.joinedAtMs > 0n ? Number(p.joinedAtMs) : Number(p.joinedAt) * 1000;
  return new Date(ms > 0 ? ms : Date.now());
}

/** Applies one verified event. Rooms that aren't a voice channel of **this** DB are ignored (B.6a rule 3). */
async function applyEvent(db: Db, voice: VoiceState, event: WebhookEvent): Promise<void> {
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
    voice.participantJoined(channelId, { userId, sid: participant.sid, joinedAt: joinedAtOf(event) });
  } else {
    // `participant_connection_aborted` counts as left.
    voice.participantLeft(channelId, userId, participant.sid);
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
  { db, env, voice }: Pick<RouteDeps, 'db' | 'env' | 'voice'>,
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

      if (voice.claimEvent(event.id)) {
        try {
          await voice.exclusive(() => applyEvent(db, voice, event));
        } catch (err) {
          // Let LiveKit's retry of this id be processed.
          voice.releaseEvent(event.id);
          throw err;
        }
      } else {
        request.log.debug({ eventId: event.id }, 'duplicate LiveKit webhook ignored');
      }
      return reply.status(200).send();
    });
    done();
  });
}
