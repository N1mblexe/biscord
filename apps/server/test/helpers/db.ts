import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { createDb, type DbHandle } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { unitDatabaseUrl } from './env.js';

/** Every table defined in the Drizzle schema. */
export const APP_TABLES: readonly string[] = Object.values(schema as Record<string, unknown>)
  .flatMap((value) => (is(value, PgTable) ? [getTableName(value)] : []))
  .sort();

let handle: DbHandle | undefined;

/** One pool per test file, connected to `hearth_unit`. */
export function testDb(): DbHandle {
  handle ??= createDb(unitDatabaseUrl(), { max: 4 });
  return handle;
}

export async function closeTestDb(): Promise<void> {
  const current = handle;
  handle = undefined;
  await current?.pool.end();
}

export async function truncateAll(): Promise<void> {
  const tables = APP_TABLES.map((name) => `"${name}"`).join(', ');
  await testDb().db.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}
