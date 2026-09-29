import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, PublicUser, UserResponse, UsersResponse, type Me } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users as usersTable } from '../src/db/schema.js';
import type { UserRow } from '../src/db/types.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { connectRecording, listen, type RecordingClient } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import {
  filePart,
  freshUploadDir,
  gifBytes,
  injectMultipart,
  jpegBytes,
  listFiles,
  pngBytes,
  removeDir,
  webpBytes,
  type Multipart,
} from './helpers/uploads.js';

let app: FastifyInstance;
let baseUrl: string;
let uploadDir: string;
let alice: UserRow;
let aliceCookie: string;
let bobCookie: string;
const opened: RecordingClient[] = [];

beforeEach(async () => {
  await truncateAll();
  uploadDir = await freshUploadDir();
  app = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir }) });
  baseUrl = await listen(app);
  alice = await insertUser('alice');
  await insertUser('bob');
  aliceCookie = await login(app, 'alice');
  bobCookie = await login(app, 'bob');
});
afterEach(async () => {
  for (const s of opened.splice(0)) s.client.disconnect();
  await app.close();
  await removeDir(uploadDir);
});
afterAll(closeTestDb);

/** As alice, or anonymously with `anonymous: true`. */
const putAvatar = (body: Multipart, { anonymous = false } = {}): Promise<LightMyRequestResponse> =>
  injectMultipart(app, 'PUT', '/api/me/avatar', body, anonymous ? undefined : aliceCookie);

function me(res: LightMyRequestResponse): Me {
  expect(res.statusCode, res.payload).toBe(200);
  return UserResponse.parse(res.json()).user;
}

const avatarFiles = () => listFiles(path.join(uploadDir, 'avatars'));
const storedKey = async (): Promise<string | null> => {
  const [row] = await testDb()
    .db.select({ key: usersTable.avatarKey })
    .from(usersTable)
    .where(eq(usersTable.id, alice.id));
  return row?.key ?? null;
};

async function connectBob(): Promise<RecordingClient> {
  const s = await connectRecording(baseUrl, bobCookie, { ignore: ['presence', 'readstate:updated'] });
  opened.push(s);
  return s;
}

describe('avatars', () => {
  it('set → avatarUrl with ?v=, file under avatars/, user:updated broadcast, served with the cache header', async () => {
    const bob = await connectBob();
    const png = pngBytes(4, 4);
    const user = me(await putAvatar(filePart('me.png', png, 'text/plain')));

    const key = await storedKey();
    expect(key).toMatch(/^avatars\/[0-9a-f-]{36}$/);
    expect(user.avatarUrl).toBe(
      `/api/avatars/${alice.id}?v=${key?.slice('avatars/'.length, 'avatars/'.length + 8)}`,
    );
    expect(await avatarFiles()).toEqual([key?.slice('avatars/'.length)]);
    expect(await readFile(path.join(uploadDir, key ?? ''))).toEqual(png);

    await bob.waitFor('user:updated');
    expect(bob.of('user:updated')).toEqual([{ user: PublicUser.parse({ ...user, createdAt: undefined }) }]);

    // Everywhere a user is serialized.
    const list = UsersResponse.parse((await api(app, 'GET', '/api/users', { cookie: bobCookie })).json());
    expect(list.users.find((u) => u.id === alice.id)?.avatarUrl).toBe(user.avatarUrl);

    const res = await api(app, 'GET', user.avatarUrl ?? '', { cookie: bobCookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.rawPayload).toEqual(png);
  });

  it('jpeg and webp are accepted', async () => {
    expect(me(await putAvatar(filePart('a.jpg', jpegBytes()))).avatarUrl).not.toBeNull();
    expect(me(await putAvatar(filePart('a.webp', webpBytes()))).avatarUrl).not.toBeNull();
    const res = await api(app, 'GET', `/api/avatars/${alice.id}`, { cookie: bobCookie });
    expect(res.headers['content-type']).toBe('image/webp');
  });

  it('replace → the old file is unlinked after the commit and v changes', async () => {
    const first = me(await putAvatar(filePart('1.png', pngBytes(1, 1))));
    const firstKey = await storedKey();
    const second = me(await putAvatar(filePart('2.png', pngBytes(2, 2))));
    const secondKey = await storedKey();
    expect(secondKey).not.toBe(firstKey);
    expect(second.avatarUrl).not.toBe(first.avatarUrl);
    expect(await avatarFiles()).toEqual([secondKey?.slice('avatars/'.length)]);
  });

  it('delete → avatarUrl null, file unlinked, user:updated; GET → 404; deleting again is a no-op', async () => {
    me(await putAvatar(filePart('1.png', pngBytes())));
    const bob = await connectBob();
    const user = me(await api(app, 'DELETE', '/api/me/avatar', { cookie: aliceCookie }));
    expect(user.avatarUrl).toBeNull();
    expect(await storedKey()).toBeNull();
    expect(await avatarFiles()).toEqual([]);
    await bob.waitFor('user:updated');
    const [event] = bob.of('user:updated') as { user: { id: string; avatarUrl: string | null } }[];
    expect(bob.of('user:updated')).toHaveLength(1);
    expect(event?.user).toMatchObject({ id: alice.id, avatarUrl: null });
    expectError(await api(app, 'GET', `/api/avatars/${alice.id}`, { cookie: bobCookie }), 404, 'NOT_FOUND');

    me(await api(app, 'DELETE', '/api/me/avatar', { cookie: aliceCookie }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.of('user:updated')).toHaveLength(1);
  });

  it('gif, svg or anything else → 415 UNSUPPORTED_MEDIA; over 2 MB → 413; nothing stored', async () => {
    expectError(await putAvatar(filePart('a.gif', gifBytes(), 'image/png')), 415, 'UNSUPPORTED_MEDIA');
    expectError(
      await putAvatar(filePart('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')),
      415,
      'UNSUPPORTED_MEDIA',
    );
    const big = Buffer.concat([pngBytes(), Buffer.alloc(LIMITS.avatarMaxBytes)]);
    expectError(await putAvatar(filePart('big.png', big)), 413, 'PAYLOAD_TOO_LARGE');
    expectError(await putAvatar(filePart('empty.png', Buffer.alloc(0))), 400, 'VALIDATION');
    expect(await storedKey()).toBeNull();
    expect(await listFiles(uploadDir)).toEqual([]);
  });

  it('anonymous → 401 for PUT, DELETE and GET; unknown user or no avatar → 404', async () => {
    expectError(await putAvatar(filePart('a.png', pngBytes()), { anonymous: true }), 401, 'UNAUTHENTICATED');
    expectError(await api(app, 'DELETE', '/api/me/avatar'), 401, 'UNAUTHENTICATED');
    expectError(await api(app, 'GET', `/api/avatars/${alice.id}`), 401, 'UNAUTHENTICATED');
    expectError(await api(app, 'GET', `/api/avatars/${alice.id}`, { cookie: bobCookie }), 404, 'NOT_FOUND');
    expectError(
      await api(app, 'GET', '/api/avatars/00000000-0000-4000-8000-000000000000', { cookie: bobCookie }),
      404,
      'NOT_FOUND',
    );
  });

  it("a deactivated user's avatar is still served", async () => {
    const user = me(await putAvatar(filePart('a.png', pngBytes())));
    await testDb()
      .db.update(usersTable)
      .set({ deactivatedAt: new Date() })
      .where(eq(usersTable.id, alice.id));
    const res = await api(app, 'GET', user.avatarUrl ?? '', { cookie: bobCookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });
});
