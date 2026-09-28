import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import type { Queryable } from './types.js';

/** Every table defined in the Drizzle schema, sorted. */
export const APP_TABLE_NAMES: readonly string[] = Object.values(schema as Record<string, unknown>)
  .flatMap((value) => (is(value, PgTable) ? [getTableName(value)] : []))
  .sort();

/** Empties every app table in one statement (test reset only). */
export async function truncateAppTables(db: Queryable): Promise<void> {
  const tables = APP_TABLE_NAMES.map((name) => `"${name}"`).join(', ');
  await db.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}
