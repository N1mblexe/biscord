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
import { createChannel, deleteChannel, renameChannel, reorderChannels } from '../services/channels.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 rows 15–18 (admin). Every broadcast goes to room `all`, after the commit. */
export function registerChannelRoutes(
  app: FastifyInstance,
  { db, guards, realtime, storage, voice, voiceBackend }: RouteDeps,
): void {
  app.post('/api/channels', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const input = parse(CreateChannelRequest, request.body);
    const channel = toChannel(await createChannel(db, input));
    realtime.emitToAll('channel:created', { channel });
    return send(reply, ChannelResponse, { channel }, 201);
  });

  app.patch('/api/channels/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const { name } = parse(UpdateChannelRequest, request.body);
    const channel = toChannel(await renameChannel(db, id, name));
    realtime.emitToAll('channel:updated', { channel });
    return send(reply, ChannelResponse, { channel });
  });

  app.put('/api/channels/order', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { ids } = parse(ReorderChannelsRequest, request.body);
    const channels = (await reorderChannels(db, ids)).map(toChannel);
    realtime.emitToAll('channels:reordered', { channels });
    return send(reply, ChannelsResponse, { channels });
  });

  app.delete('/api/channels/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const { channel, storageKeys } = await deleteChannel(db, id, { voiceBackend, log: request.log });
    // Its LiveKit webhooks are ignored from now on (no such channel); drop its members silently.
    if (channel.type === 'voice')
      await voice.exclusive(() => {
        voice.forgetChannel(channel.id);
      });
    realtime.emitToAll('channel:deleted', { channelId: channel.id });
    // B.7: files go after the commit and the broadcast; failures are logged, never thrown.
    await storage.removeKeys(storageKeys);
    return reply.status(204).send();
  });
}
