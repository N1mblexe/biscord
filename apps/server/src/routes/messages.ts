import type { FastifyInstance } from 'fastify';
import {
  CreateMessageRequest,
  IdParams,
  ListMessagesQuery,
  ListMessagesResponse,
  MessageIdParams,
  MessageResponse,
  UpdateMessageRequest,
} from '@hearth/shared';
import { send } from '../lib/respond.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { emitToChannel } from '../realtime/audience.js';
import { assertCanPost, loadChannelForUser } from '../services/access.js';
import { createMessage, deleteMessage, editMessage, listMessages, toMessages } from '../services/messages.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 rows 20–23. Broadcasts go to the channel audience (B.5), after the commit. Messages carry
 * their attachments, reactions and mentions (batch-loaded per page).
 */
export function registerMessageRoutes(
  app: FastifyInstance,
  { db, guards, rateLimiter, realtime, storage }: RouteDeps,
): void {
  app.get('/api/channels/:id/messages', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await loadChannelForUser(db, authOf(request).user, id);
    const query = parse(ListMessagesQuery, request.query);
    const rows = await listMessages(db, id, query);
    return send(reply, ListMessagesResponse, { messages: await toMessages(db, rows) });
  });

  app.post(
    '/api/channels/:id/messages',
    { preHandler: guards.requireUser, config: rateLimiter.messageSend },
    async (request, reply) => {
      const { user } = authOf(request);
      const { id } = parse(IdParams, request.params);
      const access = await loadChannelForUser(db, user, id);
      await assertCanPost(db, access);
      const input = parse(CreateMessageRequest, request.body);
      const { message, authorReadState } = await createMessage(db, {
        access,
        authorId: user.id,
        content: input.content,
        attachmentIds: input.attachmentIds,
        nonce: input.nonce,
      });
      emitToChannel(realtime, access, 'message:created', { message });
      // B.5a rule 3: sending moves the sender's read state forward; their other tabs follow.
      realtime.emitToUser(user.id, 'readstate:updated', { readState: authorReadState });
      return send(reply, MessageResponse, { message }, 201);
    },
  );

  app.patch('/api/messages/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = parse(MessageIdParams, request.params);
    const { content } = parse(UpdateMessageRequest, request.body);
    const { message, access } = await editMessage(db, authOf(request).user, id, content);
    emitToChannel(realtime, access, 'message:updated', { message });
    return send(reply, MessageResponse, { message });
  });

  app.delete('/api/messages/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = parse(MessageIdParams, request.params);
    const { message, access, storageKeys } = await deleteMessage(db, authOf(request).user, id);
    emitToChannel(realtime, access, 'message:deleted', {
      channelId: message.channelId,
      messageId: String(message.id),
    });
    // B.7: files go after the commit and the broadcast; failures are logged, never thrown.
    await storage.removeKeys(storageKeys);
    return reply.status(204).send();
  });
}
