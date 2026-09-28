import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './client.js';

/** `apps/server/drizzle`, from both `src/db` (tsx/vitest) and `dist/db` (production). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set');
  }
  const { pool, db } = createDb(url);
  try {
    await runMigrations(db);
    console.log(`Migrations applied from ${MIGRATIONS_FOLDER}`);
  } finally {
    await pool.end();
  }
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err: unknown) => {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
