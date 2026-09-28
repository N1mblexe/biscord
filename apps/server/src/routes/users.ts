import type { FastifyInstance } from 'fastify';
import { UsersResponse } from '@hearth/shared';
import { send } from '../lib/respond.js';
import { toPublicUser } from '../lib/serialize.js';
import { listUsers } from '../services/users.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 row 13: every user, deactivated included. */
export function registerUserRoutes(app: FastifyInstance, { db, guards }: RouteDeps): void {
  app.get('/api/users', { preHandler: guards.requireUser }, async (_request, reply) => {
    const rows = await listUsers(db);
    return send(reply, UsersResponse, { users: rows.map(toPublicUser) });
  });
}
