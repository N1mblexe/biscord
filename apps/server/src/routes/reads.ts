import type { FastifyInstance } from 'fastify';
import { IdParams, MarkReadRequest, ReadStateResponse } from '@hearth/shared';
import { send } from '../lib/respond.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { loadChannelForUser } from '../services/access.js';
import { markRead } from '../services/reads.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 row 26: forward-only; `readstate:updated` goes to the caller's own sockets only. */
export function registerReadRoutes(app: FastifyInstance, { db, guards, realtime }: RouteDeps): void {
  app.post('/api/channels/:id/read', { preHandler: guards.requireUser }, async (request, reply) => {
    const { user } = authOf(request);
    const { id } = parse(IdParams, request.params);
    const access = await loadChannelForUser(db, user, id);
    const { messageId } = parse(MarkReadRequest, request.body);
    const readState = await markRead(db, user.id, access.channel.id, messageId);
    realtime.emitToUser(user.id, 'readstate:updated', { readState });
    return send(reply, ReadStateResponse, { readState });
  });
}
