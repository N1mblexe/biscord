import type { FileHandle } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AttachmentParams, AttachmentResponse, IdParams, LIMITS } from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { isInlineImage, toAttachment } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf } from '../plugins/auth.js';
import {
  deleteUnattached,
  ensureUploadQuota,
  insertAttachmentWithinQuota,
  loadAttachmentForUser,
} from '../services/attachments.js';
import { contentDisposition } from '../storage/filenames.js';
import {
  ensureFreeSpace,
  FALLBACK_MIME_TYPE,
  openStoredFile,
  receiveUpload,
  statStoredFile,
} from '../storage/files.js';
import { newAttachmentKey, type Storage } from '../storage/paths.js';
import type { RouteDeps } from './deps.js';

/** Headers every stored file is served with (B.7a rule 4): never sniffed, never scriptable. */
export const FILE_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
} as const;

/**
 * What a file response sends: the file's size, and for a GET its open handle. A HEAD only stats the file,
 * so it is never opened or read. The file routes declare `method: ['GET', 'HEAD']`, so Fastify doesn't
 * add its automatic HEAD route, which would run the GET handler and read the whole stream to discard it.
 */
export interface FileBody {
  size: number;
  /** `null` for a HEAD request. */
  handle: FileHandle | null;
}

/** Prepares the response body of stored file `key` for this request's method; `null` when it is missing. */
export async function prepareFileBody(
  request: FastifyRequest,
  storage: Storage,
  key: string,
): Promise<FileBody | null> {
  if (request.method === 'HEAD') {
    const size = await statStoredFile(storage, key);
    return size === null ? null : { size, handle: null };
  }
  return openStoredFile(storage, key);
}

/** Closes a prepared body that won't be sent. */
export async function discardFileBody(body: FileBody): Promise<void> {
  await body.handle?.close();
}

/**
 * Sends a prepared body with `headers`, the security headers and its length. A GET streams the file (the
 * handle closes when the stream ends or is destroyed); a HEAD sends no payload, and Fastify keeps the
 * explicit content-length.
 */
export function sendFileBody(
  reply: FastifyReply,
  body: FileBody,
  headers: Record<string, string>,
): FastifyReply {
  reply.status(200).headers({ ...FILE_SECURITY_HEADERS, ...headers, 'content-length': String(body.size) });
  return body.handle === null ? reply.send() : reply.send(body.handle.createReadStream());
}

/**
 * CONTRACTS B.4 rows 27–28b and B.7a rules 2–4. Registered in the multipart-enabled context (see `app.ts`).
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  { db, env, guards, rateLimiter, storage }: RouteDeps,
): void {
  app.post(
    '/api/attachments',
    { preHandler: guards.requireUser, config: rateLimiter.upload },
    async (request, reply) => {
      const { user } = authOf(request);
      // B.7a rule 8: refuse before a single byte of the body is read or stored. Only a fast path: the
      // insert re-checks under the user's quota lock (B.9 rule 7).
      await ensureUploadQuota(db, user.id);
      await ensureFreeSpace(storage, env.UPLOAD_MIN_FREE_MB);
      const file = await receiveUpload(request, storage, {
        maxBytes: LIMITS.uploadMaxBytes,
        finalKey: () => newAttachmentKey(),
      });
      const row = await insertAttachmentWithinQuota(db, {
        uploaderId: user.id,
        storageKey: file.key,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      }).catch(async (err: unknown) => {
        // No row (a concurrent upload took the last quota slot, or the insert failed), no file.
        await storage.removeKeys([file.key]);
        throw err;
      });
      return send(reply, AttachmentResponse, { attachment: toAttachment(row) }, 201);
    },
  );

  // Row 28b: the composer drops an upload the user removed or never sent (B.9 rule 7). Same per-user rate
  // limit as uploads (its own counter). The file is unlinked after the commit.
  app.delete(
    '/api/attachments/:id',
    { preHandler: guards.requireUser, config: rateLimiter.upload },
    async (request, reply) => {
      const { id } = parse(IdParams, request.params);
      const key = await deleteUnattached(db, authOf(request).user.id, id);
      await storage.removeKeys([key]);
      return reply.status(204).send();
    },
  );

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/attachments/:id/:filename',
    preHandler: guards.requireUser,
    handler: async (request, reply) => {
      // `:filename` is cosmetic (validated for shape only); the lookup is by id.
      const { id } = parse(AttachmentParams, request.params);
      const row = await loadAttachmentForUser(db, authOf(request).user, id);
      const body = await prepareFileBody(request, storage, row.storageKey);
      if (body === null) {
        request.log.warn({ attachmentId: row.id }, 'attachment file missing on disk');
        throw new AppError('NOT_FOUND', 'Attachment not found');
      }
      const inline = isInlineImage(row.mimeType);
      return sendFileBody(reply, body, {
        // Only allowlisted images keep their type; everything else is an opaque download.
        'content-type': inline ? row.mimeType : FALLBACK_MIME_TYPE,
        'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', row.filename),
        'cache-control': 'private, max-age=31536000, immutable',
      });
    },
  });
}
