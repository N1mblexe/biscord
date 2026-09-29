import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { fileTypeFromFile } from 'file-type';
import { AppError } from '../lib/errors.js';
import { sanitizeFilename } from './filenames.js';
import { isNotFoundError, newTmpKey, type Storage } from './paths.js';

export const FALLBACK_MIME_TYPE = 'application/octet-stream';
/** The one multipart part an upload accepts (B.7a rule 3). */
export const UPLOAD_FIELD = 'file';

export interface ReceivedFile {
  /** The final storage key (already renamed into place). */
  key: string;
  /** Sanitized client filename (display only). */
  filename: string;
  /** Sniffed from the content; the client-declared type is ignored. */
  mimeType: string;
  sizeBytes: number;
}

export interface ReceiveOptions {
  maxBytes: number;
  /** Generates the final key (`yyyy/mm/<uuid>` or `avatars/<uuid>`). */
  finalKey: () => string;
  /** When set, a sniffed type outside the list → 415 UNSUPPORTED_MEDIA (avatars). */
  allowedTypes?: readonly string[];
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * CONTRACTS B.7a rule 8: refuses an upload (507 STORAGE_FULL) before anything is streamed when the
 * `UPLOAD_DIR` filesystem has less than `minFreeMb` free. `0` disables the check.
 */
export async function ensureFreeSpace(storage: Storage, minFreeMb: number): Promise<void> {
  if (minFreeMb <= 0) return;
  if ((await storage.freeBytes()) < minFreeMb * BYTES_PER_MB) {
    throw new AppError('STORAGE_FULL', 'The server is out of storage space');
  }
}

const tooLarge = (maxBytes: number): AppError =>
  new AppError('PAYLOAD_TOO_LARGE', `File is too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`);

/** Counts bytes as they stream and fails the pipeline as soon as the cap is crossed. */
class ByteCounter extends Transform {
  bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(tooLarge(this.maxBytes));
      return;
    }
    callback(null, chunk);
  }
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : undefined;
}

/** A filesystem error (has a `syscall`): the server's problem, never the client's. */
function isFsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && typeof Reflect.get(err, 'syscall') === 'string';
}

/**
 * Multipart parser errors (limits, malformed or truncated bodies) are the client's: VALIDATION, except the
 * file size limit (413).
 */
function toClientError(err: unknown, maxBytes: number): unknown {
  if (err instanceof AppError || isFsError(err)) return err;
  if (errorCode(err) === 'FST_REQ_FILE_TOO_LARGE') return tooLarge(maxBytes);
  return new AppError('VALIDATION', 'Expected exactly one multipart file part named "file"');
}

/**
 * Stops reading the rest of a rejected request body: detach the multipart parser and let the remainder
 * drain, so the connection isn't left stalled on backpressure.
 */
function drain(request: FastifyRequest): void {
  const raw = request.raw;
  if (raw.readableEnded || raw.destroyed) return;
  raw.unpipe();
  raw.resume();
}

/**
 * CONTRACTS B.7 "upload" and B.7a rule 3: streams the single `file` part to `tmp/<uuid>` with a byte cap
 * enforced mid-stream, checks that nothing else was sent, sniffs the type from the magic bytes and renames
 * the file to its final key. Any failure (abort, overflow, extra parts, sniff or fs error) unlinks the temp
 * file and nothing is kept; the caller inserts the row and unlinks the final key if that fails.
 */
export async function receiveUpload(
  request: FastifyRequest,
  storage: Storage,
  options: ReceiveOptions,
): Promise<ReceivedFile> {
  if (!request.isMultipart()) {
    throw new AppError('VALIDATION', 'Expected a multipart/form-data body with one part named "file"');
  }
  const { maxBytes } = options;
  const parts = request.parts({
    // One byte over the cap, so the counter sees the overflow and fails immediately (busboy itself would
    // only stop at the cap and wait for the end of the part).
    limits: { fileSize: maxBytes + 1, files: 1, fields: 0, parts: 1 },
  });

  const tmpKey = newTmpKey();
  const tmpPath = storage.resolve(tmpKey);
  let renamed = false;
  try {
    let part: MultipartFile;
    try {
      const first = await parts.next();
      if (first.done === true || first.value.type !== 'file' || first.value.fieldname !== UPLOAD_FIELD) {
        if (first.done !== true && first.value.type === 'file') first.value.file.destroy();
        throw new AppError('VALIDATION', 'Expected exactly one multipart file part named "file"');
      }
      part = first.value;
    } catch (err) {
      throw toClientError(err, maxBytes);
    }

    const counter = new ByteCounter(maxBytes);
    try {
      await pipeline(part.file, counter, createWriteStream(tmpPath, { flags: 'wx' }));
    } catch (err) {
      throw toClientError(err, maxBytes);
    }
    // Defense in depth: busboy marks a part it cut at its own limit.
    if (part.file.truncated) throw tooLarge(maxBytes);

    try {
      const rest = await parts.next();
      if (rest.done !== true) {
        if (rest.value.type === 'file') rest.value.file.destroy();
        throw new AppError('VALIDATION', 'Expected exactly one multipart file part named "file"');
      }
    } catch (err) {
      throw toClientError(err, maxBytes);
    }

    if (counter.bytes === 0) throw new AppError('VALIDATION', 'The file is empty');

    const sniffed = await fileTypeFromFile(tmpPath);
    const mimeType = sniffed?.mime ?? FALLBACK_MIME_TYPE;
    if (options.allowedTypes !== undefined && !options.allowedTypes.includes(mimeType)) {
      throw new AppError('UNSUPPORTED_MEDIA', 'Unsupported file type');
    }

    const key = options.finalKey();
    const finalPath = storage.resolve(key);
    await mkdir(path.dirname(finalPath), { recursive: true });
    await rename(tmpPath, finalPath);
    renamed = true;
    return { key, filename: sanitizeFilename(part.filename), mimeType, sizeBytes: counter.bytes };
  } catch (err) {
    drain(request);
    throw err;
  } finally {
    if (!renamed) {
      try {
        await storage.unlink(tmpKey);
      } catch (err) {
        request.log.error({ err }, 'failed to unlink a temp upload');
      }
    }
  }
}

export interface OpenedFile {
  handle: FileHandle;
  size: number;
}

/** Opens a stored file for streaming, or `null` when it is missing on disk. */
export async function openStoredFile(storage: Storage, key: string): Promise<OpenedFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(storage.resolve(key), 'r');
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: stats.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** Size of a stored regular file without opening it (HEAD requests), or `null` when it is missing. */
export async function statStoredFile(storage: Storage, key: string): Promise<number | null> {
  try {
    const stats = await stat(storage.resolve(key));
    return stats.isFile() ? stats.size : null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/** Sniffs a stored file's type (avatars carry no stored MIME type). */
export async function sniffStoredFile(storage: Storage, key: string): Promise<string> {
  return (await fileTypeFromFile(storage.resolve(key)))?.mime ?? FALLBACK_MIME_TYPE;
}
