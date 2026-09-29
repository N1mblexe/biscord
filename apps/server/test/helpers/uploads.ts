import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@hearth/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';

/** A fresh upload directory inside the run's temp root. Remove it with `removeDir`. */
export function freshUploadDir(): Promise<string> {
  return mkdtemp(path.join(inject('uploadRoot'), 'u-'));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Every file (relative path, `/`-separated) under `dir`, sorted; `[]` if it doesn't exist. */
export async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid `width`×`height` RGB PNG, generated in code. */
export function pngBytes(width = 1, height = 1): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type RGB
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0; // filter byte
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Magic-byte headers file-type recognises, padded with zeros. */
export const jpegBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    Buffer.alloc(64),
  ]);
export const gifBytes = (): Buffer => Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64)]);
export function webpBytes(): Buffer {
  const header = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary');
  header.writeUInt32LE(64 + 4 + 8, 4);
  return Buffer.concat([header, Buffer.alloc(64)]);
}
export const pdfBytes = (): Buffer =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  );

export interface Part {
  name?: string;
  /** Omit for a plain field. */
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

export interface Multipart {
  payload: Buffer;
  contentType: string;
}

/** Encodes `parts` as a multipart/form-data body (the filename is sent raw, as browsers do for UTF-8). */
export function multipart(parts: readonly Part[]): Multipart {
  const boundary = `----hearth${randomUUID().replaceAll('-', '')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name ?? 'file'}"`
        : `form-data; name="${part.name ?? 'file'}"; filename="${part.filename.replaceAll('"', '%22')}"`;
    const headers = [`Content-Disposition: ${disposition}`];
    if (part.filename !== undefined)
      headers.push(`Content-Type: ${part.contentType ?? 'application/octet-stream'}`);
    chunks.push(Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8'));
    chunks.push(typeof part.data === 'string' ? Buffer.from(part.data, 'utf8') : part.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** One file part named `file`. */
export function filePart(filename: string, data: Buffer | string, contentType?: string): Multipart {
  return multipart([{ filename, data, ...(contentType === undefined ? {} : { contentType }) }]);
}

/** `app.inject` with a multipart body, the CSRF header and the session cookie. */
export function injectMultipart(
  app: FastifyInstance,
  method: 'POST' | 'PUT',
  url: string,
  body: Multipart,
  cookie: string | undefined,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
    'content-type': body.contentType,
  };
  if (cookie !== undefined) headers.cookie = cookie;
  return app.inject({ method, url, headers, payload: body.payload });
}
