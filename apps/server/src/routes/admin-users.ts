import type { FastifyInstance } from 'fastify';
import { IdParams, PublicUserResponse, ResetCodeResponse, UpdateUserRoleRequest } from '@hearth/shared';
import { send } from '../lib/respond.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { issueResetCode } from '../services/resetCodes.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 rows 35–38 (admin; B.7 / B.7b). Every route counts toward the admin mutation limit. */
export function registerAdminUserRoutes(
  app: FastifyInstance,
  { db, guards, rateLimiter, lifecycle }: RouteDeps,
): void {
  const preHandler = [guards.requireAdmin, rateLimiter.adminMutation];

  app.patch('/api/admin/users/:id', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const { role } = parse(UpdateUserRoleRequest, request.body);
    const user = await lifecycle.changeRole(authOf(request).user.id, id, role);
    return send(reply, PublicUserResponse, { user });
  });

  app.post('/api/admin/users/:id/deactivate', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await lifecycle.deactivateUser(authOf(request).user.id, id, request.log);
    return reply.status(204).send();
  });

  app.post('/api/admin/users/:id/reactivate', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await lifecycle.reactivateUser(authOf(request).user.id, id);
    return reply.status(204).send();
  });

  app.post('/api/admin/users/:id/reset-code', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    // The admin re-check (B.7b rule 7) and the NOT_FOUND check run inside the issuing transaction.
    const { code, expiresAt } = await issueResetCode(db, id, authOf(request).user.id);
    return send(reply, ResetCodeResponse, { code, expiresAt: expiresAt.toISOString() });
  });
}
