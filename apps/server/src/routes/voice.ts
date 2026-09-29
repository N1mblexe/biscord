import type { FastifyInstance } from 'fastify';
import { ChannelIdParams, VoiceTokenResponse } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { parse } from '../lib/validate.js';
import { mintVoiceToken } from '../livekit/token.js';
import { authOf } from '../plugins/auth.js';
import { findChannel } from '../services/channels.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 row 29 / B.6 / B.6a rule 2. Voice channels only (unknown, text or DM → 404); an inactive
 * user has no session (401). Minting is local: LIVEKIT_UNAVAILABLE only while the cached health says down.
 */
export function registerVoiceRoutes(
  app: FastifyInstance,
  { db, env, guards, rateLimiter, livekitHealth }: RouteDeps,
): void {
  app.post(
    '/api/voice/:channelId/token',
    { preHandler: guards.requireUser, config: rateLimiter.voiceToken },
    async (request, reply) => {
      const { user } = authOf(request);
      const { channelId } = parse(ChannelIdParams, request.params);
      const channel = await findChannel(db, channelId);
      if (channel?.type !== 'voice') throw new AppError('NOT_FOUND', 'Voice channel not found');
      if (livekitHealth.cached() === 'down') {
        throw new AppError('LIVEKIT_UNAVAILABLE', 'Voice server unavailable');
      }
      const minted = await mintVoiceToken(env, {
        channelId: channel.id,
        userId: user.id,
        displayName: user.displayName,
      });
      return send(reply, VoiceTokenResponse, {
        token: minted.token,
        url: env.LIVEKIT_PUBLIC_URL,
        roomName: minted.roomName,
        expiresAt: minted.expiresAt.toISOString(),
      });
    },
  );
}
