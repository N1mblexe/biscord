import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@hearth/shared';
import type { Db } from '../db/client.js';

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

export function registerHealthRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  app.get('/api/health', async (request, reply): Promise<HealthResponse> => {
    try {
      await pingDb(db);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      request.log.warn({ err }, 'health check: database unreachable');
      reply.code(503);
      return { status: 'degraded', db: 'down' };
    }
  });
}
