import type { FastifyInstance } from 'fastify';
import { CreateDmRequest, DmChannelResponse } from '@hearth/shared';
import { send } from '../lib/respond.js';
import { toDmChannel } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { getOrCreateDm } from '../services/dms.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 row 19: get-or-create. New → 201 + `dm:created` to both members; existing → 200, no event. */
export function registerDmRoutes(app: FastifyInstance, { db, guards, realtime }: RouteDeps): void {
  app.post('/api/dms', { preHandler: guards.requireUser }, async (request, reply) => {
    const { user } = authOf(request);
    const { userId } = parse(CreateDmRequest, request.body);
    const dm = await getOrCreateDm(db, user, userId);
    const otherUserId = dm.lowId === user.id ? dm.highId : dm.lowId;

    if (dm.created) {
      // Each member sees the DM from its own side: `otherUserId` differs per recipient.
      realtime.emitToUser(dm.lowId, 'dm:created', { channel: toDmChannel(dm.channelId, dm.highId) });
      realtime.emitToUser(dm.highId, 'dm:created', { channel: toDmChannel(dm.channelId, dm.lowId) });
    }
    return send(
      reply,
      DmChannelResponse,
      { channel: toDmChannel(dm.channelId, otherUserId) },
      dm.created ? 201 : 200,
    );
  });
}
