import type { FastifyInstance } from 'fastify';
import { ChangePasswordRequest, UpdateMeRequest, UserResponse } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { toMe, toPublicUser } from '../lib/serialize.js';
import { parse, parseLenient } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { changePassword } from '../services/auth.js';
import { updateProfile } from '../services/users.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 rows 7–9. */
export function registerMeRoutes(
  app: FastifyInstance,
  { db, guards, realtime, rateLimiter }: RouteDeps,
): void {
  app.get('/api/me', { preHandler: guards.requireUser }, async (request, reply) => {
    return send(reply, UserResponse, { user: toMe(authOf(request).user) });
  });

  app.patch('/api/me', { preHandler: guards.requireUser }, async (request, reply) => {
    const { user } = authOf(request);
    const changes = parse(UpdateMeRequest, request.body);
    const updated = await updateProfile(db, user.id, changes);
    if (updated === null) throw new AppError('UNAUTHENTICATED', 'Authentication required');
    // B.11 rule 2: `locale` is private, so a locale-only change is not broadcast.
    if (changes.displayName !== undefined) {
      realtime.emitToAll('user:updated', { user: toPublicUser(updated) });
    }
    return send(reply, UserResponse, { user: toMe(updated) });
  });

  // B.7b rule 7: 10 per minute per user (429 RATE_LIMITED with retryAfterMs).
  app.post(
    '/api/me/password',
    { preHandler: guards.requireUser, config: rateLimiter.changePassword },
    async (request, reply) => {
      const input = parseLenient(ChangePasswordRequest, request.body);
      if (input === null) throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
      const revoked = await changePassword(db, authOf(request), input);
      realtime.revokeSessions(revoked, 'password_changed');
      return reply.status(204).send();
    },
  );
}
