import { readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  AttachmentResponse,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  LIMITS,
  MessageResponse,
  RateLimitedDetails,
  type Attachment,
} from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachments } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { STORAGE_KEY_RE } from '../src/storage/paths.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel, insertDm, listen } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import {
  filePart,
  freshUploadDir,
  gifBytes,
  injectMultipart,
  jpegBytes,
  listFiles,
  multipart,
  pdfBytes,
  pngBytes,
  removeDir,
  webpBytes,
  type Multipart,
} from './helpers/uploads.js';
import { waitUntil } from './helpers/wait.js';

type Name = 'alice' | 'bob' | 'carol';

let app: FastifyInstance;
let uploadDir: string;
let users: Record<Name, UserRow>;
const cookies: Record<Name, string> = { alice: '', bob: '', carol: '' };
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  uploadDir = await freshUploadDir();
  app = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir }) });
  await app.ready();
  users = {
    alice: await insertUser('alice'),
    bob: await insertUser('bob'),
    carol: await insertUser('carol'),
  };
  for (const name of ['alice', 'bob', 'carol'] as const) cookies[name] = await login(app, name);
  general = await insertChannel('general');
});
afterEach(async () => {
  await app.close();
  await removeDir(uploadDir);
});
afterAll(closeTestDb);

const upload = (who: Name | null, body: Multipart): Promise<LightMyRequestResponse> =>
  injectMultipart(app, 'POST', '/api/attachments', body, who === null ? undefined : cookies[who]);

function uploaded(res: LightMyRequestResponse): Attachment {
  expect(res.statusCode, res.payload).toBe(201);
  return AttachmentResponse.parse(res.json()).attachment;
}

const fetchFile = (who: Name | null, url: string): Promise<LightMyRequestResponse> =>
  api(app, 'GET', url, who === null ? {} : { cookie: cookies[who] });

const rows = () => testDb().db.select().from(attachments);
const tmpFiles = () => listFiles(path.join(uploadDir, 'tmp'));
/** Stored files outside tmp/. */
const storedFiles = async (): Promise<string[]> =>
  (await listFiles(uploadDir)).filter((file) => !file.startsWith('tmp/'));

async function expectNothingStored(): Promise<void> {
  expect(await rows()).toEqual([]);
  expect(await tmpFiles()).toEqual([]);
  expect(await storedFiles()).toEqual([]);
}

describe('startup', () => {
  it('creates tmp/ and avatars/ in UPLOAD_DIR', async () => {
    expect((await stat(path.join(uploadDir, 'tmp'))).isDirectory()).toBe(true);
    expect((await stat(path.join(uploadDir, 'avatars'))).isDirectory()).toBe(true);
  });

  it('fails fast when UPLOAD_DIR is not writable', async () => {
    // A regular file where the directory should be: mkdir fails for root and non-root users alike.
    const blocker = path.join(uploadDir, 'blocker');
    await writeFile(blocker, 'x');
    const broken = makeApp({ env: testEnv({ UPLOAD_DIR: blocker }) });
    try {
      await expect(broken.ready()).rejects.toThrow(/UPLOAD_DIR is not writable/);
    } finally {
      await broken.close().catch(() => undefined);
    }
  });
});

describe('POST /api/attachments', () => {
  it('stores an unattached upload at yyyy/mm/<uuid> with the sniffed type (a PNG sent as text/plain)', async () => {
    const png = pngBytes(2, 2);
    const attachment = uploaded(await upload('alice', filePart('photo.png', png, 'text/plain')));
    expect(attachment).toMatchObject({
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
      inline: true,
      url: `/api/attachments/${attachment.id}/photo.png`,
    });

    const [row] = await rows();
    expect(row).toMatchObject({ id: attachment.id, uploaderId: users.alice.id, messageId: null });
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/`;
    expect(row?.storageKey.startsWith(yyyymm)).toBe(true);
    expect(row?.storageKey).toMatch(STORAGE_KEY_RE);
    expect(await storedFiles()).toEqual([row?.storageKey]);
    expect(await readFile(path.join(uploadDir, row?.storageKey ?? ''))).toEqual(png);
    expect(await tmpFiles()).toEqual([]);
  });

  it('an unrecognised type falls back to application/octet-stream and is not inline', async () => {
    const attachment = uploaded(await upload('alice', filePart('notes.txt', 'just text', 'image/png')));
    expect(attachment).toMatchObject({ mimeType: 'application/octet-stream', inline: false, sizeBytes: 9 });
  });

  it('anonymous → 401, missing CSRF header → 403; nothing stored', async () => {
    expectError(await upload(null, filePart('a.png', pngBytes())), 401, 'UNAUTHENTICATED');
    const body = filePart('a.png', pngBytes());
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { cookie: cookies.alice, 'content-type': body.contentType },
      payload: body.payload,
    });
    expectError(res, 403, 'FORBIDDEN');
    await expectNothingStored();
  });

  it(`${LIMITS.uploadMaxBytes} bytes is accepted; one more byte → 413 PAYLOAD_TOO_LARGE, temp file removed`, async () => {
    const big = Buffer.alloc(LIMITS.uploadMaxBytes + 1, 0x61);
    expectError(await upload('alice', filePart('big.bin', big)), 413, 'PAYLOAD_TOO_LARGE');
    await expectNothingStored();

    const exact = uploaded(
      await upload('alice', filePart('exact.bin', big.subarray(0, LIMITS.uploadMaxBytes))),
    );
    expect(exact.sizeBytes).toBe(LIMITS.uploadMaxBytes);
    expect(await tmpFiles()).toEqual([]);
  });

  it('a 0-byte file → 400 VALIDATION', async () => {
    expectError(await upload('alice', filePart('empty.txt', Buffer.alloc(0))), 400, 'VALIDATION');
    await expectNothingStored();
  });

  it('anything but exactly one part named "file" → 400 VALIDATION, nothing stored', async () => {
    const png = pngBytes();
    const bodies: Multipart[] = [
      multipart([
        { filename: 'a.png', data: png },
        { filename: 'b.png', data: png },
      ]),
      multipart([
        { filename: 'a.png', data: png },
        { name: 'extra', data: 'x' },
      ]),
      multipart([
        { name: 'extra', data: 'x' },
        { filename: 'a.png', data: png },
      ]),
      multipart([{ name: 'upload', filename: 'a.png', data: png }]),
      multipart([{ name: 'file', data: 'not a file part' }]),
      multipart([]),
    ];
    for (const body of bodies) {
      expectError(await upload('alice', body), 400, 'VALIDATION');
    }
    // Not multipart at all.
    expectError(
      await api(app, 'POST', '/api/attachments', { cookie: cookies.alice, body: { file: 'x' } }),
      400,
      'VALIDATION',
    );
    await expectNothingStored();
  });

  it('multipart bodies are refused by JSON routes (the parser is scoped to the upload routes)', async () => {
    const res = await injectMultipart(
      app,
      'POST',
      '/api/channels',
      filePart('a.png', pngBytes()),
      cookies.alice,
    );
    expectError(res, 415, 'UNSUPPORTED_MEDIA');
  });

  it(`the ${LIMITS.rateLimits.uploads.max + 1}st upload within a minute → 429 RATE_LIMITED, per user`, async () => {
    for (let i = 0; i < LIMITS.rateLimits.uploads.max; i++) {
      uploaded(await upload('alice', filePart(`f${i}.txt`, `file ${i}`)));
    }
    const res = await upload('alice', filePart('late.txt', 'late'));
    const { retryAfterMs } = RateLimitedDetails.parse(expectError(res, 429, 'RATE_LIMITED').error.details);
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(await rows()).toHaveLength(LIMITS.rateLimits.uploads.max);
    uploaded(await upload('bob', filePart('bob.txt', 'bob')));
  });

  it('an upload aborted mid-stream leaves no row and no file (temp file removed)', async () => {
    const baseUrl = await listen(app);
    const body = filePart('big.bin', Buffer.alloc(4 * 1024 * 1024, 0x62));
    const half = body.payload.subarray(0, Math.floor(body.payload.length / 2));
    const { port } = new URL(baseUrl);

    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/attachments',
      headers: {
        [CSRF_HEADER]: CSRF_HEADER_VALUE,
        cookie: cookies.alice,
        'content-type': body.contentType,
        'content-length': String(body.payload.length),
      },
    });
    request.on('error', () => undefined); // the socket is destroyed on purpose
    const response = new Promise<number | undefined>((resolve) => {
      request.on('response', (res) => {
        resolve(res.statusCode);
      });
      request.on('close', () => {
        resolve(undefined);
      });
    });
    request.write(half);
    // The server is streaming into tmp/ by now; then the client vanishes.
    await waitUntil(async () => (await tmpFiles()).length === 1, { message: 'temp file', timeoutMs: 5_000 });
    request.destroy();
    expect(await response).toBeUndefined();

    await waitUntil(async () => (await tmpFiles()).length === 0, {
      message: 'temp cleanup',
      timeoutMs: 5_000,
    });
    await expectNothingStored();
  });

  it('filenames are sanitized and never touch the storage path', async () => {
    const cases: [string, string][] = [
      ['../../etc/passwd', 'passwd'],
      ['a\\b.txt', 'b.txt'],
      ['..\\x', 'x'],
      ['..', 'file'],
      ['', 'file'],
      ['ev\u0001il\u001b\u007f.txt', 'evil.txt'],
      ['report‮fdp.exe', 'reportfdp.exe'],
      [`${'é'.repeat(150)}.txt`, 'é'.repeat(127)],
    ];
    for (const [raw, expected] of cases) {
      const attachment = uploaded(await upload('alice', filePart(raw, 'content')));
      expect(attachment.filename, JSON.stringify(raw)).toBe(expected);
      expect(Buffer.byteLength(attachment.filename)).toBeLessThanOrEqual(255);
    }
    for (const row of await rows()) expect(row.storageKey).toMatch(STORAGE_KEY_RE);
    // Everything landed inside UPLOAD_DIR, under yyyy/mm/.
    const stored = await storedFiles();
    expect(stored).toHaveLength(cases.length);
    for (const file of stored) expect(file).toMatch(STORAGE_KEY_RE);
  });

  it('a NUL in the filename is stripped', async () => {
    const attachment = uploaded(await upload('alice', filePart('evil\u0000.txt', 'content')));
    expect(attachment.filename).toBe('evil.txt');
  });
});

describe('GET /api/attachments/:id/:filename', () => {
  async function send(who: Name, channelId: string, ids: string[], content = ''): Promise<void> {
    const res = await api(app, 'POST', `/api/channels/${channelId}/messages`, {
      cookie: cookies[who],
      body: { content, attachmentIds: ids },
    });
    expect(res.statusCode, res.payload).toBe(201);
  }

  it.each([
    ['png', pngBytes(), 'image/png'],
    ['jpeg', jpegBytes(), 'image/jpeg'],
    ['gif', gifBytes(), 'image/gif'],
    ['webp', webpBytes(), 'image/webp'],
  ])('%s is served inline with its own type and the security headers', async (_label, bytes, mime) => {
    const attachment = uploaded(await upload('alice', filePart('pic', bytes)));
    expect(attachment).toMatchObject({ mimeType: mime, inline: true });
    const res = await fetchFile('alice', attachment.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(mime);
    expect(res.headers['content-disposition']).toBe(`inline; filename="pic"; filename*=UTF-8''pic`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.rawPayload).toEqual(bytes);
  });

  it.each([
    [
      'evil.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'application/octet-stream',
    ],
    [
      'prolog.svg',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'application/xml',
    ],
    ['evil.html', '<!doctype html><html><script>alert(1)</script></html>', 'application/octet-stream'],
    ['report.pdf', pdfBytes(), 'application/pdf'],
    ['blob.bin', Buffer.from([1, 2, 3, 4, 5]), 'application/octet-stream'],
  ])(
    '%s is an application/octet-stream attachment download, whatever was sniffed',
    async (filename, data, sniffed) => {
      // The declared type is a lie on purpose; it's ignored.
      const attachment = uploaded(await upload('alice', filePart(filename, data, 'image/png')));
      expect(attachment).toMatchObject({ mimeType: sniffed, inline: false });
      const res = await fetchFile('alice', attachment.url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    },
  );

  it('a non-ASCII filename round-trips through the RFC 5987 filename*', async () => {
    const name = 'résumé (v2) 📄 100%.pdf';
    const attachment = uploaded(await upload('alice', filePart(name, pdfBytes())));
    expect(attachment.filename).toBe(name);
    expect(attachment.url).toBe(`/api/attachments/${attachment.id}/${encodeURIComponent(name)}`);
    const res = await fetchFile('alice', attachment.url);
    expect(res.statusCode, res.payload).toBe(200);
    const header = String(res.headers['content-disposition']);
    const match =
      /^attachment; filename="([\x20-\x7e]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]+)$/.exec(header);
    expect(match, header).not.toBeNull();
    expect(match?.[1]).toBe('r_sum_ (v2) _ 100_.pdf');
    expect(decodeURIComponent(match?.[2] ?? '')).toBe(name);
  });

  it('a 255-byte filename is served (long percent-encoded URL segment)', async () => {
    const name = `${'ü'.repeat(125)}.bin`; // 250 + 4 bytes
    const attachment = uploaded(await upload('alice', filePart(name, 'x')));
    expect(attachment.filename).toBe(name);
    expect((await fetchFile('alice', attachment.url)).statusCode).toBe(200);
  });

  it('the :filename segment is cosmetic; the lookup is by id', async () => {
    const attachment = uploaded(await upload('alice', filePart('real.png', pngBytes())));
    const res = await fetchFile('alice', `/api/attachments/${attachment.id}/whatever.exe`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('filename="real.png"');
  });

  it('anonymous → 401; unknown id → 404', async () => {
    const attachment = uploaded(await upload('alice', filePart('a.png', pngBytes())));
    expectError(await fetchFile(null, attachment.url), 401, 'UNAUTHENTICATED');
    expectError(
      await fetchFile('alice', '/api/attachments/00000000-0000-4000-8000-000000000000/a.png'),
      404,
      'NOT_FOUND',
    );
  });

  it("someone else's unattached upload → 404; once attached in a text channel everyone can read it", async () => {
    const attachment = uploaded(await upload('alice', filePart('a.png', pngBytes())));
    expectError(await fetchFile('bob', attachment.url), 404, 'NOT_FOUND');
    await send('alice', general.id, [attachment.id]);
    expect((await fetchFile('bob', attachment.url)).statusCode).toBe(200);
    expect((await fetchFile('carol', attachment.url)).statusCode).toBe(200);
  });

  it('a DM attachment → 404 for a non-member, 200 for both members', async () => {
    const dmId = await insertDm(users.alice.id, users.bob.id);
    const attachment = uploaded(await upload('alice', filePart('secret.pdf', pdfBytes())));
    await send('alice', dmId, [attachment.id], 'for your eyes only');
    expect((await fetchFile('alice', attachment.url)).statusCode).toBe(200);
    expect((await fetchFile('bob', attachment.url)).statusCode).toBe(200);
    expectError(await fetchFile('carol', attachment.url), 404, 'NOT_FOUND');
  });

  it('a row whose file is missing on disk → 404', async () => {
    const attachment = uploaded(await upload('alice', filePart('a.png', pngBytes())));
    const [row] = await rows();
    await removeDir(path.join(uploadDir, row?.storageKey ?? 'missing'));
    expectError(await fetchFile('alice', attachment.url), 404, 'NOT_FOUND');
  });
});

describe('sending with attachments', () => {
  it('the message carries its attachments (upload order); claiming another user’s upload → VALIDATION', async () => {
    const first = uploaded(await upload('alice', filePart('one.png', pngBytes())));
    const second = uploaded(await upload('alice', filePart('two.pdf', pdfBytes())));
    const res = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: '', attachmentIds: [second.id, first.id] },
    });
    expect(res.statusCode, res.payload).toBe(201);
    const { message } = MessageResponse.parse(res.json());
    expect(message.attachments).toEqual([first, second]);
    const [claimed] = await testDb().db.select().from(attachments).where(eq(attachments.id, first.id));
    expect(claimed?.messageId).toBe(Number(message.id));

    const bobs = uploaded(await upload('bob', filePart('b.png', pngBytes())));
    const stolen = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: 'mine now', attachmentIds: [bobs.id] },
    });
    expect(expectError(stolen, 400, 'VALIDATION').error.message).toBe('Unknown attachment');
    // An attachment can't be claimed twice either.
    const again = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: 'again', attachmentIds: [first.id] },
    });
    expectError(again, 400, 'VALIDATION');
  });
});
