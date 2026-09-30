import http from 'node:http';
import path from 'node:path';
import { CSRF_HEADER, CSRF_HEADER_VALUE, LIMITS, RateLimitedDetails } from '@hearth/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachments } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import * as users from '../src/services/users.js';
import * as files from '../src/storage/files.js';
import { newAttachmentKey, type StatfsFn } from '../src/storage/paths.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel, listen } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import {
  filePart,
  freshUploadDir,
  injectMultipart,
  listFiles,
  pngBytes,
  removeDir,
  type Multipart,
} from './helpers/uploads.js';

// Pass-through spies: prove a refused upload never starts streaming, and a HEAD never opens the file.
vi.mock('../src/storage/files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof files>();
  return {
    ...actual,
    receiveUpload: vi.fn(actual.receiveUpload),
    openStoredFile: vi.fn(actual.openStoredFile),
  };
});
// Pass-through, so a test can make the user row "vanish" at the moment the avatar key is written.
vi.mock('../src/services/users.js', async (importOriginal) => {
  const actual = await importOriginal<typeof users>();
  return { ...actual, replaceAvatarKey: vi.fn(actual.replaceAvatarKey) };
});
const receiveSpy = vi.mocked(files.receiveUpload);
const openSpy = vi.mocked(files.openStoredFile);
const replaceAvatarSpy = vi.mocked(users.replaceAvatarKey);

const MiB = 1024 * 1024;

let app: FastifyInstance;
let uploadDir: string;
let alice: UserRow;
const cookies = { alice: '', bob: '' };
let general: ChannelRow;
/** Extra apps a test builds (other env / statfs); closed after it. */
const extraApps: FastifyInstance[] = [];

beforeEach(async () => {
  await truncateAll();
  uploadDir = await freshUploadDir();
  app = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir }) });
  await app.ready();
  alice = await insertUser('alice');
  await insertUser('bob');
  cookies.alice = await login(app, 'alice');
  cookies.bob = await login(app, 'bob');
  general = await insertChannel('general');
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const extra of extraApps.splice(0)) await extra.close();
  await app.close();
  await removeDir(uploadDir);
});
afterAll(closeTestDb);

const uploadAs = (
  who: keyof typeof cookies,
  body: Multipart = filePart('a.txt', 'hello'),
  target: FastifyInstance = app,
): Promise<LightMyRequestResponse> => injectMultipart(target, 'POST', '/api/attachments', body, cookies[who]);

const putAvatar = (target: FastifyInstance = app): Promise<LightMyRequestResponse> =>
  injectMultipart(target, 'PUT', '/api/me/avatar', filePart('me.png', pngBytes()), cookies.alice);

const rowCount = async (): Promise<number> => (await testDb().db.select().from(attachments)).length;
const tmpFiles = () => listFiles(path.join(uploadDir, 'tmp'));
/** Stored files outside tmp/. */
const storedFiles = async (): Promise<string[]> =>
  (await listFiles(uploadDir)).filter((file) => !file.startsWith('tmp/'));

/** Unattached rows for alice straight in the DB (no files: the quota only counts rows). */
async function seedUnattached(sizes: readonly number[]): Promise<string[]> {
  if (sizes.length === 0) return [];
  const rows = await testDb()
    .db.insert(attachments)
    .values(
      sizes.map((sizeBytes, i) => ({
        uploaderId: alice.id,
        storageKey: newAttachmentKey(),
        filename: `seed-${i}.bin`,
        mimeType: 'application/octet-stream',
        sizeBytes,
      })),
    )
    .returning({ id: attachments.id });
  return rows.map((row) => row.id);
}

/** A second app on the same DB and upload dir (sessions stay valid), with other env or statfs. */
async function extraApp(env: NodeJS.ProcessEnv, statfs?: StatfsFn): Promise<FastifyInstance> {
  const extra = makeApp({
    env: testEnv({ UPLOAD_DIR: uploadDir, ...env }),
    ...(statfs === undefined ? {} : { statfs }),
  });
  extraApps.push(extra);
  await extra.ready();
  return extra;
}

/**
 * Sends only the first 64 KiB of a 4 MiB multipart upload over a real socket and waits for the response.
 * A response while the body is still incomplete proves the server refused before streaming it.
 */
async function respondsBeforeBody(
  baseUrl: string,
  method: 'POST' | 'PUT',
  urlPath: string,
): Promise<{ status: number | undefined; body: string }> {
  const { port } = new URL(baseUrl);
  const body = filePart('big.bin', Buffer.alloc(4 * MiB, 0x62));
  const request = http.request({
    host: '127.0.0.1',
    port,
    method,
    path: urlPath,
    headers: {
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      cookie: cookies.alice,
      'content-type': body.contentType,
      'content-length': String(body.payload.length),
    },
  });
  request.on('error', () => undefined); // destroyed on purpose below
  const response = new Promise<{ status: number | undefined; body: string }>((resolve) => {
    request.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
  });
  request.write(body.payload.subarray(0, 64 * 1024));
  try {
    return await response;
  } finally {
    request.destroy();
  }
}

describe('unattached upload quota (409 UPLOAD_QUOTA, B.7a rule 8)', () => {
  it(`by count: the ${LIMITS.unattachedUploadsMaxFiles}th unattached upload is accepted, the next is refused before streaming`, async () => {
    await seedUnattached(Array.from({ length: LIMITS.unattachedUploadsMaxFiles - 1 }, () => 10));
    expect((await uploadAs('alice')).statusCode).toBe(201);
    expect(receiveSpy).toHaveBeenCalledTimes(1);
    const stored = await storedFiles();

    const res = await uploadAs('alice');
    expect(expectError(res, 409, 'UPLOAD_QUOTA').error.message).toBe(
      'Too many files waiting to be sent. Send or remove some first.',
    );
    expect(receiveSpy).toHaveBeenCalledTimes(1); // nothing streamed
    expect(await rowCount()).toBe(LIMITS.unattachedUploadsMaxFiles);
    expect(await storedFiles()).toEqual(stored);
    expect(await tmpFiles()).toEqual([]);

    // Per user: bob is unaffected.
    expect((await uploadAs('bob')).statusCode).toBe(201);
  });

  it(`by bytes: ${LIMITS.unattachedUploadsMaxBytes / MiB} MiB of unattached uploads refuses the next one`, async () => {
    await seedUnattached([LIMITS.unattachedUploadsMaxBytes - 6]);
    // Just under the cap: allowed, and it takes the total to exactly the cap.
    expect((await uploadAs('alice', filePart('six.txt', 'sixsix'))).statusCode).toBe(201);
    expectError(await uploadAs('alice'), 409, 'UPLOAD_QUOTA');
    expect(receiveSpy).toHaveBeenCalledTimes(1);
    expect(await rowCount()).toBe(2);
    expect(await tmpFiles()).toEqual([]);
  });

  it('attaching uploads to a message frees the quota (attached rows do not count)', async () => {
    const ids = await seedUnattached(Array.from({ length: LIMITS.unattachedUploadsMaxFiles }, () => 10));
    expectError(await uploadAs('alice'), 409, 'UPLOAD_QUOTA');

    const sent = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: 'files', attachmentIds: ids.slice(0, LIMITS.attachmentsPerMessage) },
    });
    expect(sent.statusCode, sent.payload).toBe(201);
    expect((await uploadAs('alice')).statusCode).toBe(201);

    // Bytes: a huge upload blocks the next one until it is attached.
    const [big] = await seedUnattached([LIMITS.unattachedUploadsMaxBytes]);
    expectError(await uploadAs('alice'), 409, 'UPLOAD_QUOTA');
    const claim = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: 'big', attachmentIds: [big] },
    });
    expect(claim.statusCode, claim.payload).toBe(201);
    expect((await uploadAs('alice')).statusCode).toBe(201);
  });

  it('is atomic under concurrency (B.9 rule 7): 10 parallel uploads at one free slot → exactly one 201', async () => {
    await seedUnattached(Array.from({ length: LIMITS.unattachedUploadsMaxFiles - 1 }, () => 10));
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => uploadAs('alice', filePart(`race-${i}.txt`, `race ${i}`))),
    );
    const statuses = responses.map((res) => res.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    for (const res of responses.filter((r) => r.statusCode !== 201)) expectError(res, 409, 'UPLOAD_QUOTA');
    expect(await rowCount()).toBe(LIMITS.unattachedUploadsMaxFiles);
    // The losers' stored files were removed: only the winner's file is on disk, nothing left in tmp/.
    expect(await storedFiles()).toHaveLength(1);
    expect(await tmpFiles()).toEqual([]);
  });

  it('the refusal is sent while the request body is still incomplete (checked before streaming)', async () => {
    await seedUnattached(Array.from({ length: LIMITS.unattachedUploadsMaxFiles }, () => 10));
    const res = await respondsBeforeBody(await listen(app), 'POST', '/api/attachments');
    expect(res.status).toBe(409);
    expect(res.body).toContain('UPLOAD_QUOTA');
    expect(receiveSpy).not.toHaveBeenCalled();
    expect(await tmpFiles()).toEqual([]);
    expect(await rowCount()).toBe(LIMITS.unattachedUploadsMaxFiles);
  });
});

describe('free space (507 STORAGE_FULL, B.7a rule 8)', () => {
  const freeMiB = (mib: number) =>
    vi.fn<StatfsFn>(() => Promise.resolve({ bavail: (mib * MiB) / 4096, bsize: 4096 }));

  it('attachments and avatars are refused below UPLOAD_MIN_FREE_MB, before streaming; nothing stored', async () => {
    const statfs = freeMiB(2047);
    const full = await extraApp({ UPLOAD_MIN_FREE_MB: '2048' }, statfs);

    expect(expectError(await uploadAs('alice', undefined, full), 507, 'STORAGE_FULL').error.message).toBe(
      'The server is out of storage space',
    );
    expectError(await putAvatar(full), 507, 'STORAGE_FULL');
    expect(statfs).toHaveBeenCalledWith(uploadDir);
    expect(receiveSpy).not.toHaveBeenCalled();
    expect(await rowCount()).toBe(0);
    expect(await listFiles(uploadDir)).toEqual([]);

    // Over a real socket: answered while the body is still incomplete.
    const baseUrl = await listen(full);
    for (const [method, url] of [
      ['POST', '/api/attachments'],
      ['PUT', '/api/me/avatar'],
    ] as const) {
      const res = await respondsBeforeBody(baseUrl, method, url);
      expect(res.status, `${method} ${url}`).toBe(507);
      expect(res.body).toContain('STORAGE_FULL');
    }
    expect(receiveSpy).not.toHaveBeenCalled();
    expect(await listFiles(uploadDir)).toEqual([]);
  });

  it('exactly UPLOAD_MIN_FREE_MB free is enough', async () => {
    const roomy = await extraApp({ UPLOAD_MIN_FREE_MB: '2048' }, freeMiB(2048));
    expect((await uploadAs('alice', undefined, roomy)).statusCode).toBe(201);
    expect((await putAvatar(roomy)).statusCode).toBe(200);
  });

  it('UPLOAD_MIN_FREE_MB=0 disables the check; the real statfs is used by default', async () => {
    const statfs = vi.fn<StatfsFn>(() => Promise.reject(new Error('must not be called')));
    const disabled = await extraApp({ UPLOAD_MIN_FREE_MB: '0' }, statfs);
    expect((await uploadAs('alice', undefined, disabled)).statusCode).toBe(201);
    expect(statfs).not.toHaveBeenCalled();

    // The real fs.statfs on the test's temp dir (1 MB is surely free).
    const real = await extraApp({ UPLOAD_MIN_FREE_MB: '1' });
    expect((await uploadAs('alice', undefined, real)).statusCode).toBe(201);
    expect((await putAvatar(real)).statusCode).toBe(200);
  });
});

describe('avatar rate limit (B.7a rule 8)', () => {
  it(`the ${LIMITS.rateLimits.uploads.max + 1}st PUT /api/me/avatar within a minute → 429, nothing stored`, async () => {
    for (let i = 0; i < LIMITS.rateLimits.uploads.max; i++) {
      expect((await putAvatar()).statusCode).toBe(200);
    }
    const avatarsBefore = await listFiles(path.join(uploadDir, 'avatars'));
    const res = expectError(await putAvatar(), 429, 'RATE_LIMITED');
    expect(RateLimitedDetails.parse(res.error.details).retryAfterMs).toBeGreaterThan(0);
    expect(receiveSpy).toHaveBeenCalledTimes(LIMITS.rateLimits.uploads.max);
    expect(await listFiles(path.join(uploadDir, 'avatars'))).toEqual(avatarsBefore);
    expect(avatarsBefore).toHaveLength(1);
  });

  it(`the ${LIMITS.rateLimits.uploads.max + 1}st DELETE /api/me/avatar within a minute → 429, per user`, async () => {
    for (let i = 0; i < LIMITS.rateLimits.uploads.max; i++) {
      expect((await api(app, 'DELETE', '/api/me/avatar', { cookie: cookies.alice })).statusCode).toBe(200);
    }
    expectError(await api(app, 'DELETE', '/api/me/avatar', { cookie: cookies.alice }), 429, 'RATE_LIMITED');
    expect((await api(app, 'DELETE', '/api/me/avatar', { cookie: cookies.bob })).statusCode).toBe(200);
  });
});

describe('avatar orphan (the user row vanishes mid-request)', () => {
  it('the just-stored file is removed before the error', async () => {
    replaceAvatarSpy.mockResolvedValueOnce(null);
    expectError(await putAvatar(), 401, 'UNAUTHENTICATED');
    expect(replaceAvatarSpy).toHaveBeenCalledTimes(1);
    expect(receiveSpy).toHaveBeenCalledTimes(1); // the file was stored, then removed
    expect(await listFiles(uploadDir)).toEqual([]);
  });
});

describe('HEAD on file routes', () => {
  it('an attachment: 200 with the GET headers and no body; the file is never opened', async () => {
    const png = pngBytes(3, 3);
    const up = await uploadAs('alice', filePart('pic.png', png));
    const { attachment } = up.json<{ attachment: { url: string } }>();

    const head = await api(app, 'HEAD', attachment.url, { cookie: cookies.alice });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(png.length));
    expect(head.headers['content-type']).toBe('image/png');
    expect(head.headers['content-disposition']).toBe(`inline; filename="pic.png"; filename*=UTF-8''pic.png`);
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    expect(head.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(head.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(head.rawPayload).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control: GET opens and streams it.
    const get = await api(app, 'GET', attachment.url, { cookie: cookies.alice });
    expect(get.rawPayload).toEqual(png);
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Same access rules: anonymous 401, someone else's unattached upload 404.
    expect((await api(app, 'HEAD', attachment.url)).statusCode).toBe(401);
    expect((await api(app, 'HEAD', attachment.url, { cookie: cookies.bob })).statusCode).toBe(404);
    // A missing file is 404 for HEAD too.
    await removeDir(uploadDir);
    expect((await api(app, 'HEAD', attachment.url, { cookie: cookies.alice })).statusCode).toBe(404);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('an avatar: 200 with the GET headers and no body; the file is never opened for streaming', async () => {
    const png = pngBytes(4, 4);
    const res = await injectMultipart(app, 'PUT', '/api/me/avatar', filePart('me.png', png), cookies.alice);
    const avatarUrl = res.json<{ user: { avatarUrl: string } }>().user.avatarUrl;

    const head = await api(app, 'HEAD', avatarUrl, { cookie: cookies.bob });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(png.length));
    expect(head.headers['content-type']).toBe('image/png');
    expect(head.headers['cache-control']).toBe('private, max-age=86400');
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    expect(head.rawPayload).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();

    expect((await api(app, 'GET', avatarUrl, { cookie: cookies.bob })).rawPayload).toEqual(png);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});
