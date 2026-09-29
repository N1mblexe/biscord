import type { FastifyInstance } from 'fastify';
import { CreateInviteRequest, IdParams, InviteResponse, InvitesResponse } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { toInvite } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { createInvite, listInvites, revokeInvite } from '../services/invites.js';
import { lockStillAdmin } from '../services/users.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 rows 32–34. Admin-created invites always grant `member`. Create and revoke count toward the
 * admin mutation limit; the listing doesn't.
 */
export function registerAdminInviteRoutes(
  app: FastifyInstance,
  { db, guards, rateLimiter }: RouteDeps,
): void {
  const preHandler = guards.requireAdmin;
  const mutation = [guards.requireAdmin, rateLimiter.adminMutation];

  app.get('/api/admin/invites', { preHandler }, async (_request, reply) => {
    const rows = await listInvites(db);
    return send(reply, InvitesResponse, { invites: rows.map(toInvite) });
  });

  app.post('/api/admin/invites', { preHandler: mutation }, async (request, reply) => {
    // Every field is optional, so an absent body means "all defaults".
    const input = parse(CreateInviteRequest, request.body ?? {});
    const actorId = authOf(request).user.id;
    // B.7b rule 7: the actor must still be an admin when the insert commits.
    const row = await db.transaction(async (tx) => {
      await lockStillAdmin(tx, actorId);
      return createInvite(tx, {
        createdBy: actorId,
        maxUses: input.maxUses,
        expiresInHours: input.expiresInHours,
      });
    });
    return send(reply, InviteResponse, { invite: toInvite(row) }, 201);
  });

  app.delete('/api/admin/invites/:id', { preHandler: mutation }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const actorId = authOf(request).user.id;
    const found = await db.transaction(async (tx) => {
      await lockStillAdmin(tx, actorId);
      return revokeInvite(tx, id);
    });
    if (!found) throw new AppError('NOT_FOUND', 'Invite not found');
    return reply.status(204).send();
  });
}
