import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

/** What `createDb` returns: `$client` is the pool (the upload GC takes a dedicated connection from it). */
export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export interface DbHandle {
  pool: Pool;
  db: Db;
}

export function createDb(
  url: string,
  options: Omit<PoolConfig, 'connectionString'> = {},
  onPoolError: (err: Error) => void = (err) => {
    console.error('pg pool error:', err.message);
  },
): DbHandle {
  const pool = new Pool({ connectionString: url, ...options });
  // An idle client dying (e.g. Postgres restart) emits 'error'; without a listener it crashes the process.
  pool.on('error', onPoolError);
  const db = drizzle(pool, { schema });
  return { pool, db };
}
