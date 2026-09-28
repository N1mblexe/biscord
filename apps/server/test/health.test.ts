import { HealthResponse } from '@hearth/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { makeApp } from './helpers/app.js';
import { closeTestDb } from './helpers/db.js';

afterAll(closeTestDb);

describe('GET /api/health', () => {
  it('returns 200 with db ok', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
      expect(HealthResponse.parse(res.json())).toEqual({ status: 'ok', db: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('returns 503 with db down when the database is unreachable', async () => {
    const unreachable = createDb('postgres://nobody:nothing@127.0.0.1:1/none', {
      connectionTimeoutMillis: 500,
    });
    const app = makeApp({ db: unreachable.db });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'degraded', db: 'down' });
    } finally {
      await app.close();
      await unreachable.pool.end();
    }
  });
});
