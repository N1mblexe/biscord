import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { unitDatabaseUrl } from './helpers/env.js';

/** Resets `hearth_unit` to an empty schema and applies every migration once per test run. */
export default async function setup(): Promise<void> {
  const { pool, db } = createDb(unitDatabaseUrl(), { max: 1 });
  try {
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema if exists public cascade');
    await pool.query('create schema public');
    await runMigrations(db);
  } finally {
    await pool.end();
  }
}
