import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AVATAR_MIME_TYPES, AvatarQuery, LIMITS, UserIdParams, UserResponse } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { toMe, toPublicUser } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import { findUserById, replaceAvatarKey, type AvatarChange } from '../services/users.js';
import { ensureFreeSpace, receiveUpload, sniffStoredFile } from '../storage/files.js';
import { newAvatarKey } from '../storage/paths.js';
import { discardFileBody, prepareFileBody, sendFileBody } from './attachments.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 rows 10, 11 and 14, B.7a rule 5. Registered in the multipart-enabled context (see `app.ts`).
 */
export function registerAvatarRoutes(
  app: FastifyInstance,
  { db, env, guards, rateLimiter, realtime, storage }: RouteDeps,
): void {
  /** After the commit: tell everyone (the `?v=` in `avatarUrl` changed), then unlink the replaced file. */
  const afterChange = async (change: AvatarChange): Promise<void> => {
    realtime.emitToAll('user:updated', { user: toPublicUser(change.user) });
    if (change.previousKey !== null) await storage.removeKeys([change.previousKey]);
  };

  const changeOf = (request: FastifyRequest, result: AvatarChange | null): AvatarChange => {
    if (result === null) throw new AppError('UNAUTHENTICATED', 'Authentication required');
    request.log.debug({ userId: result.user.id }, 'avatar changed');
    return result;
  };

  // Both share the upload rate limit (B.7a rule 8: 20/min/user, counted per route).
  const limited = { preHandler: guards.requireUser, config: rateLimiter.upload };

  app.put('/api/me/avatar', limited, async (request, reply) => {
    const { user } = authOf(request);
    // B.7a rule 8: refuse before anything is streamed when the disk is nearly full.
    await ensureFreeSpace(storage, env.UPLOAD_MIN_FREE_MB);
    const file = await receiveUpload(request, storage, {
      maxBytes: LIMITS.avatarMaxBytes,
      finalKey: newAvatarKey,
      allowedTypes: AVATAR_MIME_TYPES,
    });
    let result: AvatarChange | null;
    try {
      result = await replaceAvatarKey(db, user.id, file.key);
    } catch (err) {
      await storage.removeKeys([file.key]);
      throw err;
    }
    // The user row vanished: no row points to the new file, so it goes too.
    if (result === null) await storage.removeKeys([file.key]);
    const change = changeOf(request, result);
    await afterChange(change);
    return send(reply, UserResponse, { user: toMe(change.user) });
  });

  app.delete('/api/me/avatar', limited, async (request, reply) => {
    const { user } = authOf(request);
    const change = changeOf(request, await replaceAvatarKey(db, user.id, null));
    // Removing a missing avatar is a no-op: no event.
    if (change.previousKey !== null) await afterChange(change);
    return send(reply, UserResponse, { user: toMe(change.user) });
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/avatars/:userId',
    preHandler: guards.requireUser,
    handler: async (request, reply) => {
      const { userId } = parse(UserIdParams, request.params);
      parse(AvatarQuery, request.query);
      // Deactivated users keep their avatar, so old messages still render.
      const target = await findUserById(db, userId);
      const key = target?.avatarKey ?? null;
      const body = key === null ? null : await prepareFileBody(request, storage, key);
      if (key === null || body === null) throw new AppError('NOT_FOUND', 'No avatar');
      // Avatars carry no stored type: sniff the first bytes (a HEAD reads only these, never the file).
      let contentType: string;
      try {
        contentType = await sniffStoredFile(storage, key);
      } catch (err) {
        await discardFileBody(body);
        throw err;
      }
      if (!(AVATAR_MIME_TYPES as readonly string[]).includes(contentType)) {
        await discardFileBody(body);
        throw new AppError('NOT_FOUND', 'No avatar');
      }
      return sendFileBody(reply, body, {
        'content-type': contentType,
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=86400',
      });
    },
  });
}
