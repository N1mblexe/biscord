import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, isNotNull, isNull, lt } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { attachments, users } from '../db/schema.js';
import { loggableError } from '../lib/errors.js';
import { AVATAR_DIR, isNotFoundError, TMP_DIR, UUID_RE, type Storage } from './paths.js';

const HOUR_MS = 60 * 60 * 1000;
/** Unattached uploads older than this are deleted (row, then file). */
export const UNATTACHED_TTL_MS = 24 * HOUR_MS;
/** Temp files older than this belong to no live upload. */
export const TMP_TTL_MS = HOUR_MS;
/**
 * Files no row points to are only removed once this old, so a file renamed into place whose row insert is
 * still in flight is never touched.
 */
export const ORPHAN_TTL_MS = 24 * HOUR_MS;

/** Advisory lock key: one GC run at a time, across processes. ASCII "HUGC". */
export const UPLOAD_GC_LOCK_KEY = 0x48554743;

export interface GcDeps {
  db: Db;
  storage: Storage;
  log: FastifyBaseLogger;
}

export interface GcResult {
  unattachedRows: number;
  tempFiles: number;
  orphanFiles: number;
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

/** Unlinks `key` if its file was last modified before `cutoffMs`. True when it was removed. */
async function removeIfOlder(
  storage: Storage,
  key: string,
  cutoffMs: number,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    const stats = await stat(storage.resolve(key));
    if (!stats.isFile() || stats.mtimeMs >= cutoffMs) return false;
    await storage.unlink(key);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    log.error({ err: loggableError(err), storageKey: key }, 'upload gc: failed to remove a file');
    return false;
  }
}

/** Every storage key present on disk under `yyyy/mm/` and `avatars/` (files named like a uuid only). */
async function storedKeys(storage: Storage): Promise<string[]> {
  const keys: string[] = [];
  for (const top of await listDir(storage.root)) {
    if (!top.isDirectory()) continue;
    if (top.name === AVATAR_DIR) {
      for (const file of await listDir(path.join(storage.root, AVATAR_DIR))) {
        if (file.isFile() && UUID_RE.test(file.name)) keys.push(`${AVATAR_DIR}/${file.name}`);
      }
    } else if (/^\d{4}$/.test(top.name)) {
      for (const month of await listDir(path.join(storage.root, top.name))) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        for (const file of await listDir(path.join(storage.root, top.name, month.name))) {
          if (file.isFile() && UUID_RE.test(file.name)) keys.push(`${top.name}/${month.name}/${file.name}`);
        }
      }
    }
  }
  return keys;
}

interface DbStep {
  /** Keys of the expired unattached rows just deleted (their files go after the commit). */
  deletedKeys: string[];
  /** Every key an attachment or user row still points to. */
  referenced: Set<string>;
}

/** The database part of a pass, in one short transaction: no filesystem work happens inside it. */
function dbStep(db: NodePgDatabase<typeof schema>, now: number): Promise<DbStep> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(attachments)
      .where(and(isNull(attachments.messageId), lt(attachments.createdAt, new Date(now - UNATTACHED_TTL_MS))))
      .returning({ key: attachments.storageKey });
    const referenced = new Set<string>();
    for (const row of await tx.select({ key: attachments.storageKey }).from(attachments))
      referenced.add(row.key);
    for (const row of await tx
      .select({ key: users.avatarKey })
      .from(users)
      .where(isNotNull(users.avatarKey))) {
      if (row.key !== null) referenced.add(row.key);
    }
    return { deletedKeys: deleted.map((row) => row.key), referenced };
  });
}

/** The filesystem part of a pass, after the commit. */
async function fsStep(
  storage: Storage,
  log: FastifyBaseLogger,
  now: number,
  { deletedKeys, referenced }: DbStep,
): Promise<GcResult> {
  await storage.removeKeys(deletedKeys);
  const deletedSet = new Set(deletedKeys);

  let tempFiles = 0;
  for (const file of await listDir(path.join(storage.root, TMP_DIR))) {
    if (!file.isFile() || !UUID_RE.test(file.name)) continue;
    if (await removeIfOlder(storage, `${TMP_DIR}/${file.name}`, now - TMP_TTL_MS, log)) tempFiles += 1;
  }

  // A key unreferenced when the transaction read the tables can't gain a row later: rows only ever point
  // to freshly written files, and those are younger than ORPHAN_TTL_MS.
  let orphanFiles = 0;
  for (const key of await storedKeys(storage)) {
    // Files of the rows deleted above are not orphans (and are already gone).
    if (referenced.has(key) || deletedSet.has(key)) continue;
    if (await removeIfOlder(storage, key, now - ORPHAN_TTL_MS, log)) orphanFiles += 1;
  }
  return { unattachedRows: deletedKeys.length, tempFiles, orphanFiles };
}

/**
 * One GC pass (B.7, B.7a), serialized across runs and processes by a session-level advisory lock held on a
 * dedicated connection for the whole pass. Only the database step runs in a (short) transaction; the
 * filesystem walk happens after its commit, so no transaction stays open during disk I/O.
 * 1. unattached rows older than 24 h are deleted, and their files unlinked after the commit;
 * 2. temp files older than 1 h are unlinked;
 * 3. files under `yyyy/mm/` and `avatars/` older than 24 h that no attachment or user row references are
 *    unlinked (a missed post-commit unlink, a crash between rename and insert).
 * `now` is injectable so tests can age things without waiting.
 */
export async function runUploadGc(
  { db, storage, log }: GcDeps,
  { now = Date.now() } = {},
): Promise<GcResult> {
  const client = await db.$client.connect();
  let failed = false;
  try {
    await client.query('select pg_advisory_lock($1)', [UPLOAD_GC_LOCK_KEY]);
    let result: GcResult;
    try {
      const step = await dbStep(drizzle(client, { schema }), now);
      result = await fsStep(storage, log, now, step);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [UPLOAD_GC_LOCK_KEY]);
    }
    if (result.unattachedRows + result.tempFiles + result.orphanFiles > 0) log.info(result, 'upload gc');
    return result;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // After a failure the connection is destroyed, not reused: a session lock can never outlive the run.
    client.release(failed);
  }
}

export interface GcScheduler {
  /** Clears the timer and waits for a run in progress (so the DB pool isn't closed under it). */
  stop(): Promise<void>;
}

/**
 * Runs `run` every `intervalMs` (the timer doesn't keep the process alive). A tick while the previous run
 * is still going is skipped; failures are logged.
 */
export function startGcScheduler(
  intervalMs: number,
  run: () => Promise<unknown>,
  log: FastifyBaseLogger,
): GcScheduler {
  let current: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (current !== null) return;
    current = run()
      .then(
        () => undefined,
        (err: unknown) => {
          log.error({ err: loggableError(err) }, 'upload gc failed');
        },
      )
      .finally(() => {
        current = null;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await current;
    },
  };
}
