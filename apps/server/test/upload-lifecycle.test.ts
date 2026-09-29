import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AttachmentResponse, MessageResponse, type Attachment } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachments, users as usersTable } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { runUploadGc, startGcScheduler, UPLOAD_GC_LOCK_KEY } from '../src/storage/gc.js';
import { createStorage, newAttachmentKey, newAvatarKey, type Storage } from '../src/storage/paths.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import {
  filePart,
  freshUploadDir,
  injectMultipart,
  listFiles,
  pngBytes,
  removeDir,
} from './helpers/uploads.js';

const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let uploadDir: string;
let storage: Storage;
let alice: UserRow;
const cookies = { admin: '', alice: '' };
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  uploadDir = await freshUploadDir();
  app = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir }) });
  await app.ready();
  storage = createStorage(uploadDir, app.log);
  await insertUser('admin', { role: 'admin' });
  alice = await insertUser('alice');
  cookies.admin = await login(app, 'admin');
  cookies.alice = await login(app, 'alice');
  general = await insertChannel('general');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await removeDir(uploadDir);
});
afterAll(closeTestDb);

async function upload(name: string): Promise<Attachment> {
  const res = await injectMultipart(
    app,
    'POST',
    '/api/attachments',
    filePart(name, pngBytes()),
    cookies.alice,
  );
  expect(res.statusCode, res.payload).toBe(201);
  return AttachmentResponse.parse(res.json()).attachment;
}

async function sendWith(channelId: string, ids: string[]): Promise<string> {
  const res = await api(app, 'POST', `/api/channels/${channelId}/messages`, {
    cookie: cookies.alice,
    body: { content: 'files', attachmentIds: ids },
  });
  expect(res.statusCode, res.payload).toBe(201);
  return MessageResponse.parse(res.json()).message.id;
}

async function keyOf(id: string): Promise<string> {
  const [row] = await testDb()
    .db.select({ key: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.id, id));
  if (row === undefined) throw new Error('attachment row missing');
  return row.key;
}

const stored = async (): Promise<string[]> =>
  (await listFiles(uploadDir)).filter((file) => !file.startsWith('tmp/'));

describe('deletion unlinks files after the commit', () => {
  it('deleting a message removes its attachment rows and files; other files stay', async () => {
    const a = await upload('a.png');
    const b = await upload('b.png');
    const keep = await upload('keep.png');
    const messageId = await sendWith(general.id, [a.id, b.id]);
    const keepKey = await keyOf(keep.id);
    expect(await stored()).toHaveLength(3);

    const res = await api(app, 'DELETE', `/api/messages/${messageId}`, { cookie: cookies.alice });
    expect(res.statusCode).toBe(204);
    expect(await testDb().db.select().from(attachments)).toHaveLength(1);
    expect(await stored()).toEqual([keepKey]);
  });

  it('deleting a text channel removes the files of every message in it', async () => {
    const other = await insertChannel('other', { position: 1 });
    const a = await upload('a.png');
    const b = await upload('b.png');
    const c = await upload('c.png');
    await sendWith(general.id, [a.id]);
    await sendWith(general.id, [b.id]);
    await sendWith(other.id, [c.id]);
    const cKey = await keyOf(c.id);

    const res = await api(app, 'DELETE', `/api/channels/${general.id}`, { cookie: cookies.admin });
    expect(res.statusCode).toBe(204);
    expect(await stored()).toEqual([cKey]);
  });

  it('an unlink failure is logged, not thrown (the delete still succeeds)', async () => {
    const a = await upload('a.png');
    const messageId = await sendWith(general.id, [a.id]);
    const key = await keyOf(a.id);
    // Replace the file with a non-empty directory: unlink fails with EISDIR.
    await rm(path.join(uploadDir, key));
    await mkdir(path.join(uploadDir, key, 'x'), { recursive: true });
    const logged = vi.spyOn(app.log, 'error');

    const res = await api(app, 'DELETE', `/api/messages/${messageId}`, { cookie: cookies.alice });
    expect(res.statusCode).toBe(204);
    expect(await testDb().db.select().from(attachments)).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: key }),
      'failed to unlink an upload',
    );
  });

  it('a file already gone is not an error', async () => {
    const a = await upload('a.png');
    const messageId = await sendWith(general.id, [a.id]);
    await rm(path.join(uploadDir, await keyOf(a.id)));
    const logged = vi.spyOn(app.log, 'error');
    expect(
      (await api(app, 'DELETE', `/api/messages/${messageId}`, { cookie: cookies.alice })).statusCode,
    ).toBe(204);
    expect(logged).not.toHaveBeenCalled();
  });

  it('a failed delete (403) unlinks nothing', async () => {
    const a = await upload('a.png');
    const messageId = await sendWith(general.id, [a.id]);
    await insertUser('mallory');
    const mallory = await login(app, 'mallory');
    expectError(
      await api(app, 'DELETE', `/api/messages/${messageId}`, { cookie: mallory }),
      403,
      'FORBIDDEN',
    );
    expect(await stored()).toHaveLength(1);
  });
});

describe('upload GC', () => {
  const gc = (now?: number) =>
    runUploadGc({ db: testDb().db, storage, log: app.log }, now === undefined ? {} : { now });

  /** Writes a file at `key` with its mtime `ageMs` in the past. */
  async function fileAt(key: string, ageMs: number): Promise<void> {
    const full = storage.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, 'data');
    const when = new Date(Date.now() - ageMs);
    await utimes(full, when, when);
  }

  async function ageRow(id: string, ageMs: number): Promise<void> {
    await testDb()
      .db.update(attachments)
      .set({ createdAt: new Date(Date.now() - ageMs) })
      .where(eq(attachments.id, id));
  }

  it('removes old unattached rows and their files, keeps fresh and attached ones', async () => {
    const oldUnattached = await upload('old.png');
    const freshUnattached = await upload('fresh.png');
    const oldAttached = await upload('attached.png');
    await sendWith(general.id, [oldAttached.id]);
    for (const id of [oldUnattached.id, oldAttached.id]) await ageRow(id, 25 * HOUR);
    const oldKey = await keyOf(oldUnattached.id);
    const keptKeys = [await keyOf(freshUnattached.id), await keyOf(oldAttached.id)].sort();

    expect(await gc()).toEqual({ unattachedRows: 1, tempFiles: 0, orphanFiles: 0 });
    const ids = (await testDb().db.select({ id: attachments.id }).from(attachments)).map((r) => r.id).sort();
    expect(ids).toEqual([freshUnattached.id, oldAttached.id].sort());
    expect(await stored()).toEqual(keptKeys);
    expect(await stored()).not.toContain(oldKey);
  });

  it('with `now` injected: temp files go after 1 h, unattached uploads after 24 h', async () => {
    const pending = await upload('pending.png');
    const tmpKey = 'tmp/00000000-0000-4000-8000-000000000001';
    await fileAt(tmpKey, 0);

    // 2 h later: the temp file is stale, the unattached upload is not yet.
    expect(await gc(Date.now() + 2 * HOUR)).toEqual({ unattachedRows: 0, tempFiles: 1, orphanFiles: 0 });
    expect(await listFiles(path.join(uploadDir, 'tmp'))).toEqual([]);
    expect(await keyOf(pending.id)).toBeTruthy();

    // 25 h later the upload goes too, row and file.
    expect(await gc(Date.now() + 25 * HOUR)).toEqual({ unattachedRows: 1, tempFiles: 0, orphanFiles: 0 });
    expect(await testDb().db.select().from(attachments)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('removes old orphan files (attachments and avatars no row points to); keeps referenced and fresh ones', async () => {
    const oldOrphan = newAttachmentKey(new Date(Date.now() - 48 * HOUR));
    const freshOrphan = newAttachmentKey();
    const oldAvatarOrphan = newAvatarKey();
    const liveAvatar = newAvatarKey();
    await fileAt(oldOrphan, 48 * HOUR);
    await fileAt(freshOrphan, HOUR);
    await fileAt(oldAvatarOrphan, 48 * HOUR);
    await fileAt(liveAvatar, 48 * HOUR);
    await testDb().db.update(usersTable).set({ avatarKey: liveAvatar }).where(eq(usersTable.id, alice.id));
    const attached = await upload('attached.png');
    await sendWith(general.id, [attached.id]);
    const attachedKey = await keyOf(attached.id);
    await utimes(storage.resolve(attachedKey), new Date(0), new Date(0));
    // Not ours: never touched.
    await writeFile(path.join(uploadDir, 'README'), 'x');
    await utimes(path.join(uploadDir, 'README'), new Date(0), new Date(0));

    expect(await gc()).toEqual({ unattachedRows: 0, tempFiles: 0, orphanFiles: 2 });
    expect(await listFiles(uploadDir)).toEqual(
      ['README', ...[freshOrphan, liveAvatar, attachedKey].sort()].sort(),
    );
  });

  it('overlapping runs are serialized by the advisory lock', async () => {
    const old = await upload('old.png');
    await ageRow(old.id, 25 * HOUR);
    const { pool } = testDb();
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1)', [UPLOAD_GC_LOCK_KEY]);
      let settled = false;
      const first = gc().finally(() => {
        settled = true;
      });
      const second = gc();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false); // waiting for the lock
      await holder.query('commit');
      const results = await Promise.all([first, second]);
      // Exactly one of the runs deleted the row.
      expect(results.map((r) => r.unattachedRows).sort()).toEqual([0, 1]);
    } finally {
      holder.release();
    }
    expect(await stored()).toEqual([]);
  });

  it('the filesystem walk runs after the commit: no transaction open, the lock still held', async () => {
    const old = await upload('old.png');
    await ageRow(old.id, 25 * HOUR);
    const orphan = newAttachmentKey(new Date(Date.now() - 48 * HOUR));
    await fileAt(orphan, 48 * HOUR);
    const { pool } = testDb();
    const seen: { oldRows: number; openTransactions: number; locksHeld: number }[] = [];
    const unlink = storage.unlink.bind(storage);
    // removeIfOlder unlinks the orphan through `storage.unlink`, i.e. in the middle of the walk.
    vi.spyOn(storage, 'unlink').mockImplementation(async (key) => {
      const rows = await pool.query<{ n: number }>(
        'select count(*)::int as n from attachments where id = $1',
        [old.id],
      );
      const open = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and backend_type = 'client backend'
           and pid <> pg_backend_pid() and xact_start is not null`,
      );
      const locks = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and objid = $1`,
        [UPLOAD_GC_LOCK_KEY],
      );
      seen.push({
        oldRows: rows.rows[0]?.n ?? -1,
        openTransactions: open.rows[0]?.n ?? -1,
        locksHeld: locks.rows[0]?.n ?? -1,
      });
      await unlink(key);
    });

    expect(await gc()).toEqual({ unattachedRows: 1, tempFiles: 0, orphanFiles: 1 });
    // The deletion was already committed (visible to another connection) and nothing held a transaction
    // open while the walk touched the disk; the advisory lock still serialized the whole run.
    expect(seen).toEqual([{ oldRows: 0, openTransactions: 0, locksHeld: 1 }]);
    const locksAfter = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1`,
      [UPLOAD_GC_LOCK_KEY],
    );
    expect(locksAfter.rows[0]?.n).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it('the scheduler runs periodically, skips a tick while a run is in progress, and stop() waits for it', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: () => void = () => undefined;
      const run = vi.fn(async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const scheduler = startGcScheduler(1000, run, app.log);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(3000); // still running: ticks are skipped
      expect(calls).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      release();
      await stopping;
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing run is logged, and the next tick runs again', async () => {
    vi.useFakeTimers();
    try {
      const logged = vi.spyOn(app.log, 'error');
      const run = vi.fn(() => Promise.reject(new Error('boom')));
      const scheduler = startGcScheduler(1000, run, app.log);
      await vi.advanceTimersByTimeAsync(2000);
      expect(run).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledWith(expect.anything(), 'upload gc failed');
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('UPLOAD_GC_INTERVAL_MINUTES=0 starts no scheduler; a positive value does', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const off = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir, UPLOAD_GC_INTERVAL_MINUTES: '0' }) });
    await off.ready();
    const offCalls = spy.mock.calls.filter(([, ms]) => ms === 60 * 60_000).length;
    await off.close();
    const on = makeApp({ env: testEnv({ UPLOAD_DIR: uploadDir, UPLOAD_GC_INTERVAL_MINUTES: '60' }) });
    await on.ready();
    const onCalls = spy.mock.calls.filter(([, ms]) => ms === 60 * 60_000).length;
    await on.close();
    expect(offCalls).toBe(0);
    expect(onCalls).toBe(1);
  });
});
