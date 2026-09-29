import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rm, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { loggableError } from '../lib/errors.js';

/**
 * The repository root. This file is `apps/server/{src,dist}/storage/paths.{ts,js}` in every layout (dev,
 * tests, the Docker image's `/app/apps/server/dist`), so the root is four levels up.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** CONTRACTS B.7a rule 1: a relative `UPLOAD_DIR` resolves against the repo root, not the cwd. */
export function resolveUploadDir(raw: string, repoRoot: string = REPO_ROOT): string {
  return path.resolve(repoRoot, raw);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Every storage key the server ever generates (B.7a rule 2). Anything else is refused. */
export const STORAGE_KEY_RE = new RegExp(`^(?:\\d{4}/\\d{2}|avatars|tmp)/${UUID}$`);
export const UUID_RE = new RegExp(`^${UUID}$`);
export const TMP_DIR = 'tmp';
export const AVATAR_DIR = 'avatars';

/** `yyyy/mm/<uuid>` (UTC) for a new attachment. */
export function newAttachmentKey(now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}/${randomUUID()}`;
}

export function newAvatarKey(): string {
  return `${AVATAR_DIR}/${randomUUID()}`;
}

export function newTmpKey(): string {
  return `${TMP_DIR}/${randomUUID()}`;
}

function errnoCode(err: unknown): string | undefined {
  const code: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function isNotFoundError(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}

/**
 * The upload directory. Every filesystem path is derived from a server-generated storage key through
 * `resolve`, the single containment check: the key must match `STORAGE_KEY_RE` and the resolved path must
 * stay inside `root`.
 */
export interface Storage {
  /** Absolute upload directory. */
  readonly root: string;
  /** Absolute path of `key`; throws for a malformed key or a path outside `root`. */
  resolve(key: string): string;
  /** Creates `tmp/` and `avatars/` and checks they are writable (fails fast at startup). */
  init(): Promise<void>;
  /** Unlinks `key`; a missing file is fine. Throws on any other failure. */
  unlink(key: string): Promise<void>;
  /**
   * Post-commit cleanup (B.7): unlinks every key and never throws. Failures are logged; the GC reconciles
   * disk against the DB later.
   */
  removeKeys(keys: readonly string[]): Promise<void>;
  /** Test reset only: deletes everything the server stores (`tmp/`, `avatars/`, `yyyy/`), then `init`. */
  clear(): Promise<void>;
  /** Bytes available to the server on the filesystem holding `root` (B.7a rule 8). */
  freeBytes(): Promise<number>;
}

/** The part of `fs.statfs` the free-space check needs; injectable so tests can fake a full disk. */
export type StatfsFn = (dir: string) => Promise<{ bavail: number; bsize: number }>;

export interface StorageOptions {
  /** Defaults to `fs.promises.statfs`. */
  statfs?: StatfsFn;
}

export function createStorage(root: string, log: FastifyBaseLogger, options: StorageOptions = {}): Storage {
  const base = path.resolve(root);
  const statfsOf: StatfsFn = options.statfs ?? ((dir) => statfs(dir));
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;

  const resolve = (key: string): string => {
    if (!STORAGE_KEY_RE.test(key)) throw new Error('invalid storage key');
    const full = path.resolve(base, key);
    if (!full.startsWith(prefix)) throw new Error('storage key escapes UPLOAD_DIR');
    return full;
  };

  const init = async (): Promise<void> => {
    for (const dir of [TMP_DIR, AVATAR_DIR]) {
      const full = path.join(base, dir);
      try {
        await mkdir(full, { recursive: true });
        await access(full, constants.W_OK | constants.X_OK);
      } catch (err) {
        throw new Error(`UPLOAD_DIR is not writable: ${full}`, { cause: err });
      }
    }
  };

  const unlinkKey = async (key: string): Promise<void> => {
    try {
      await unlink(resolve(key));
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  };

  return {
    root: base,
    resolve,
    init,
    unlink: unlinkKey,
    async removeKeys(keys) {
      for (const key of keys) {
        try {
          await unlinkKey(key);
        } catch (err) {
          log.error({ err: loggableError(err), storageKey: key }, 'failed to unlink an upload');
        }
      }
    },
    async clear() {
      let entries: string[] = [];
      try {
        entries = await readdir(base);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
      for (const name of entries) {
        // Only the layout the server creates; anything else in the directory is left alone.
        if (name === TMP_DIR || name === AVATAR_DIR || /^\d{4}$/.test(name)) {
          await rm(path.join(base, name), { recursive: true, force: true });
        }
      }
      await init();
    },
    async freeBytes() {
      // `bavail`: blocks available to unprivileged users (the server doesn't run as root in production).
      const stats = await statfsOf(base);
      return stats.bavail * stats.bsize;
    },
  };
}
