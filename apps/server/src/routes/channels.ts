import type { FastifyInstance } from 'fastify';
import {
  ChannelResponse,
  ChannelsResponse,
  CreateChannelRequest,
  IdParams,
  ReorderChannelsRequest,
  UpdateChannelRequest,
} from '@hearth/shared';
import { send } from '../lib/respond.js';
import { toChannel } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { createChannel, renameChannel, reorderChannels } from '../services/channels.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 rows 15–18 (admin; each counts toward the admin mutation limit). Every broadcast goes to
 * room `all`, after the commit. Delete is the B.7 lifecycle flow.
 */
export function registerChannelRoutes(
  app: FastifyInstance,
  { db, guards, rateLimiter, realtime, lifecycle }: RouteDeps,
): void {
  const preHandler = [guards.requireAdmin, rateLimiter.adminMutation];

  app.post('/api/channels', { preHandler }, async (request, reply) => {
    const input = parse(CreateChannelRequest, request.body);
    const channel = toChannel(await createChannel(db, authOf(request).user.id, input));
    realtime.emitToAll('channel:created', { channel });
    return send(reply, ChannelResponse, { channel }, 201);
  });

  app.patch('/api/channels/:id', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const { name } = parse(UpdateChannelRequest, request.body);
    const channel = toChannel(await renameChannel(db, authOf(request).user.id, id, name));
    realtime.emitToAll('channel:updated', { channel });
    return send(reply, ChannelResponse, { channel });
  });

  app.put('/api/channels/order', { preHandler }, async (request, reply) => {
    const { ids } = parse(ReorderChannelsRequest, request.body);
    const channels = (await reorderChannels(db, authOf(request).user.id, ids)).map(toChannel);
    realtime.emitToAll('channels:reordered', { channels });
    return send(reply, ChannelsResponse, { channels });
  });

  app.delete('/api/channels/:id', { preHandler }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await lifecycle.deleteChannel(authOf(request).user.id, id, request.log);
    return reply.status(204).send();
  });
}
