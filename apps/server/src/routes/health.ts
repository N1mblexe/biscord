import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { loggableError } from '../lib/errors.js';
import type { LiveKitHealth } from '../livekit/health.js';

const DB_TIMEOUT_MS = 2_000;

async function pingDb(db: Db): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`db ping timed out after ${DB_TIMEOUT_MS} ms`));
    }, DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([db.execute(sql`select 1`), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CONTRACTS B.4 row 1 / B.6a rule 1. The DB ping and the (cached) LiveKit probe run in parallel. LiveKit down
 * with the DB up is 200 `degraded`; only a DB outage is a 503.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  { db, livekitHealth }: { db: Db; livekitHealth: LiveKitHealth },
): void {
  app.get('/api/health', async (request, reply): Promise<HealthResponse> => {
    const [dbStatus, livekit] = await Promise.all([
      pingDb(db).then(
        () => 'ok' as const,
        (err: unknown) => {
          request.log.warn({ err: loggableError(err) }, 'health check: database unreachable');
          return 'down' as const;
        },
      ),
      livekitHealth.check(),
    ]);
    if (dbStatus === 'down') reply.code(503);
    const status = dbStatus === 'ok' && livekit === 'ok' ? 'ok' : 'degraded';
    return { status, db: dbStatus, livekit };
  });
}
