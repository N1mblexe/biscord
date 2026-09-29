import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { unitDatabaseUrl } from './helpers/env.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Per-run temp directory under the OS temp dir; every test UPLOAD_DIR lives inside it. */
    uploadRoot: string;
  }
}

/**
 * Resets `hearth_unit` to an empty schema and applies every migration once per test run, and creates the
 * run's upload root (removed again at teardown).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { pool, db } = createDb(unitDatabaseUrl(), { max: 1 });
  try {
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema if exists public cascade');
    await pool.query('create schema public');
    await runMigrations(db);
  } finally {
    await pool.end();
  }

  const uploadRoot = await mkdtemp(path.join(tmpdir(), 'hearth-unit-uploads-'));
  project.provide('uploadRoot', uploadRoot);
  return async () => {
    await rm(uploadRoot, { recursive: true, force: true });
  };
}
