import type { FastifyInstance } from 'fastify';
import { IdParams, ResetCodeResponse } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { issueResetCode } from '../services/resetCodes.js';
import { findUserById } from '../services/users.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 row 38 (rows 35–37 arrive in Phase 8). */
export function registerAdminUserRoutes(app: FastifyInstance, { db, guards }: RouteDeps): void {
  app.post('/api/admin/users/:id/reset-code', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    if ((await findUserById(db, id)) === null) throw new AppError('NOT_FOUND', 'User not found');
    const { code, expiresAt } = await issueResetCode(db, id, authOf(request).user.id);
    return send(reply, ResetCodeResponse, { code, expiresAt: expiresAt.toISOString() });
  });
}
