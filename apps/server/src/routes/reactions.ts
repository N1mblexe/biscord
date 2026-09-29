import type { FastifyInstance } from 'fastify';
import { ReactionParams } from '@hearth/shared';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { emitToChannel } from '../realtime/audience.js';
import { addReaction, removeReaction, type ReactionChange } from '../services/reactions.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 rows 24–25. The router URL-decodes `:emoji`; it must then be a single RGI emoji
 * (VALIDATION). Always 204; `reaction:added` / `reaction:removed` go to the channel audience only when a
 * row actually changed (B.5a rule 4). Rate limit: 30 per 10 s per user, PUT and DELETE together.
 */
export function registerReactionRoutes(
  app: FastifyInstance,
  { db, guards, rateLimiter, realtime }: RouteDeps,
): void {
  // PUT and DELETE share one per-user window (30 per 10 s).
  const preHandler = [guards.requireUser, rateLimiter.reaction];

  const broadcast = (
    event: 'reaction:added' | 'reaction:removed',
    change: ReactionChange,
    emoji: string,
    userId: string,
  ): void => {
    if (!change.changed) return;
    emitToChannel(realtime, change.access, event, {
      channelId: change.message.channelId,
      messageId: String(change.message.id),
      emoji,
      userId,
    });
  };

  app.put('/api/messages/:id/reactions/:emoji', { preHandler }, async (request, reply) => {
    const { user } = authOf(request);
    const { id, emoji } = parse(ReactionParams, request.params);
    broadcast('reaction:added', await addReaction(db, user, id, emoji), emoji, user.id);
    return reply.status(204).send();
  });

  app.delete('/api/messages/:id/reactions/:emoji', { preHandler }, async (request, reply) => {
    const { user } = authOf(request);
    const { id, emoji } = parse(ReactionParams, request.params);
    broadcast('reaction:removed', await removeReaction(db, user, id, emoji), emoji, user.id);
    return reply.status(204).send();
  });
}
