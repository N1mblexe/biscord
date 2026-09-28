/**
 * Creates a single-use admin invite for the first account.
 *
 *   pnpm --filter @hearth/server bootstrap [--force]
 *   docker compose exec server node dist/cli/bootstrap.js [--force]
 *
 * Refuses when an active admin already exists, unless `--force` is given.
 */
import { createDb } from '../db/client.js';
import { EnvError, loadEnv } from '../env.js';
import { createInvite } from '../services/invites.js';
import { hasActiveAdmin } from '../services/users.js';

const INVITE_TTL_HOURS = 24;

async function main(argv: readonly string[]): Promise<number> {
  const force = argv.includes('--force');
  const env = loadEnv();
  const { pool, db } = createDb(env.DATABASE_URL);
  try {
    if (!force && (await hasActiveAdmin(db))) {
      console.error('An active admin already exists. Re-run with --force to create another admin invite.');
      return 1;
    }
    const invite = await createInvite(db, {
      createdBy: null,
      grantsRole: 'admin',
      maxUses: 1,
      expiresInHours: INVITE_TTL_HOURS,
    });
    const origin = env.APP_ORIGIN[0] ?? '';
    const url = new URL('/register', origin);
    url.searchParams.set('invite', invite.code);
    console.log(`Admin invite code: ${invite.code}`);
    console.log(`Register at:       ${url.toString()}`);
    console.log(`Single use, expires ${invite.expiresAt.toISOString()} (${INVITE_TTL_HOURS} h).`);
    return 0;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof EnvError) console.error(err.message);
    else console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
