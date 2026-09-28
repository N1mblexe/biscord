import type { FastifyInstance } from 'fastify';
import { CreateInviteRequest, IdParams, InviteResponse, InvitesResponse } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { toInvite } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { createInvite, listInvites, revokeInvite } from '../services/invites.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 rows 32–34. Admin-created invites always grant `member`. */
export function registerAdminInviteRoutes(app: FastifyInstance, { db, guards }: RouteDeps): void {
  const preHandler = guards.requireAdmin;

  app.get('/api/admin/invites', { preHandler }, async (_request, reply) => {
    const rows = await listInvites(db);
    return send(reply, InvitesResponse, { invites: rows.map(toInvite) });
  });

  app.post('/api/admin/invites', { preHandler }, async (request, reply) => {
    // Every field is optional, so an absent body means "all defaults".
    const input = parse(CreateInviteRequest, request.body ?? {});
    const row = await createInvite(db, {
      createdBy: authOf(request).user.id,
      maxUses: input.maxUses,
      expiresInHours: input.expiresInHours,
    });
    return send(reply, InviteResponse, { invite: toInvite(row) }, 201);
  });

  app.delete('/api/admin/invites/:id', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    if (!(await revokeInvite(db, id))) throw new AppError('NOT_FOUND', 'Invite not found');
    return reply.status(204).send();
  });
}
