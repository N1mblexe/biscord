import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { EnvError, loadEnv, type Env } from './env.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readEnv(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  let logPoolError = (err: Error): void => {
    console.error('pg pool error:', err.message);
  };
  const { pool, db } = createDb(env.DATABASE_URL, {}, (err) => {
    logPoolError(err);
  });

  if (env.MIGRATE_ON_START) {
    try {
      await runMigrations(db);
    } catch (err) {
      await pool.end();
      throw err;
    }
  }

  const app = buildApp({ db, env });
  logPoolError = (err) => {
    app.log.error({ err }, 'pg pool error');
  };
  if (env.MIGRATE_ON_START) app.log.info('database migrations applied');

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Don't hang forever on open connections (sockets arrive in phase 2).
    setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    await app.listen({ host: '0.0.0.0', port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    await pool.end();
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
