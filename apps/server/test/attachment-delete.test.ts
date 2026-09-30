import { AttachmentResponse, LIMITS, type Attachment } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachments } from '../src/db/schema.js';
import type { ChannelRow } from '../src/db/types.js';
import { newAttachmentKey } from '../src/storage/paths.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { filePart, freshUploadDir, injectMultipart, listFiles, removeDir } from './helpers/uploads.js';

// CONTRACTS B.4 row 28b: DELETE /api/attachments/:id — the uploader's unattached uploads only; 204, the
// file is unlinked after the commit and it stops counting toward UPLOAD_QUOTA; otherwise 404.

let app: FastifyInstance;
let uploadDir: string;
const cookies = { alice: '', bob: '' };
let aliceId: string;
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  uploadDir = await freshUploadDir();
  app = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir }) });
  await app.ready();
  aliceId = (await insertUser('alice')).id;
  await insertUser('bob');
  cookies.alice = await login(app, 'alice');
  cookies.bob = await login(app, 'bob');
  general = await insertChannel('general');
});
afterEach(async () => {
  await app.close();
  await removeDir(uploadDir);
});
afterAll(closeTestDb);

async function upload(who: keyof typeof cookies, name = 'a.txt'): Promise<Attachment> {
  const res = await injectMultipart(app, 'POST', '/api/attachments', filePart(name, 'hello'), cookies[who]);
  expect(res.statusCode, res.payload).toBe(201);
  return AttachmentResponse.parse(res.json()).attachment;
}

const del = (who: keyof typeof cookies | null, id: string): Promise<LightMyRequestResponse> =>
  api(app, 'DELETE', `/api/attachments/${id}`, who === null ? {} : { cookie: cookies[who] });

const storedFiles = async (): Promise<string[]> =>
  (await listFiles(uploadDir)).filter((file) => !file.startsWith('tmp/'));

const rowOf = async (id: string) =>
  (await testDb().db.select().from(attachments).where(eq(attachments.id, id)))[0];

describe('DELETE /api/attachments/:id', () => {
  it("204 for the uploader's unattached upload: the row and the file are gone, then 404", async () => {
    const kept = await upload('alice', 'kept.txt');
    const gone = await upload('alice', 'gone.txt');
    const keyOfKept = (await rowOf(kept.id))?.storageKey;
    expect(await storedFiles()).toHaveLength(2);

    const res = await del('alice', gone.id);
    expect(res.statusCode, res.payload).toBe(204);
    expect(res.payload).toBe('');
    expect(await rowOf(gone.id)).toBeUndefined();
    expect(await storedFiles()).toEqual([keyOfKept]);
    // Its URL no longer serves it.
    expectError(await api(app, 'GET', gone.url, { cookie: cookies.alice }), 404, 'NOT_FOUND');

    expectError(await del('alice', gone.id), 404, 'NOT_FOUND');
    expect(await rowOf(kept.id)).toBeDefined();
  });

  it("404 for an unknown id, someone else's upload, or an attached one; nothing is removed", async () => {
    const bobs = await upload('bob');
    const sent = await upload('alice', 'sent.txt');
    const post = await api(app, 'POST', `/api/channels/${general.id}/messages`, {
      cookie: cookies.alice,
      body: { content: 'with a file', attachmentIds: [sent.id] },
    });
    expect(post.statusCode, post.payload).toBe(201);
    const before = await storedFiles();

    expectError(await del('alice', '00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND');
    expectError(await del('alice', bobs.id), 404, 'NOT_FOUND');
    expectError(await del('alice', sent.id), 404, 'NOT_FOUND');
    expect(await rowOf(bobs.id)).toBeDefined();
    expect((await rowOf(sent.id))?.messageId).not.toBeNull();
    expect(await storedFiles()).toEqual(before);
  });

  it('frees the upload quota', async () => {
    const seeded = await testDb()
      .db.insert(attachments)
      .values(
        Array.from({ length: LIMITS.unattachedUploadsMaxFiles }, (_, i) => ({
          uploaderId: aliceId,
          storageKey: newAttachmentKey(),
          filename: `seed-${i}.bin`,
          mimeType: 'application/octet-stream',
          sizeBytes: 10,
        })),
      )
      .returning({ id: attachments.id });
    const blocked = await injectMultipart(
      app,
      'POST',
      '/api/attachments',
      filePart('x.txt', 'x'),
      cookies.alice,
    );
    expectError(blocked, 409, 'UPLOAD_QUOTA');

    const first = seeded[0];
    if (first === undefined) throw new Error('nothing seeded');
    // The seeded rows have no file on disk: a missing file is logged, never an error.
    expect((await del('alice', first.id)).statusCode).toBe(204);
    await upload('alice');
  });

  it('auth, CSRF and a malformed id are checked as usual', async () => {
    const mine = await upload('alice');
    expectError(await del(null, mine.id), 401, 'UNAUTHENTICATED');
    const noCsrf = await api(app, 'DELETE', `/api/attachments/${mine.id}`, {
      cookie: cookies.alice,
      noCsrf: true,
    });
    expectError(noCsrf, 403, 'FORBIDDEN');
    expectError(await del('alice', 'not-a-uuid'), 400, 'VALIDATION');
    expect(await rowOf(mine.id)).toBeDefined();
  });

  it(`has the upload rate limit: the ${LIMITS.rateLimits.uploads.max + 1}st delete within a minute → 429, per user`, async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (let i = 0; i < LIMITS.rateLimits.uploads.max; i++) {
      expectError(await del('alice', unknown), 404, 'NOT_FOUND');
    }
    expectError(await del('alice', unknown), 429, 'RATE_LIMITED');
    expectError(await del('bob', unknown), 404, 'NOT_FOUND');
  });
});
