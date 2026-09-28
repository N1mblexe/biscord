import type { FastifyInstance } from 'fastify';
import { TestResetResponse } from '@hearth/shared';
import { truncateAppTables } from '../db/tables.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { createInvite } from '../services/invites.js';
import type { RouteDeps } from './deps.js';

export const TEST_TOKEN_HEADER = 'x-test-token';

/**
 * CONTRACTS B.4 row 39. Only registered when `HEARTH_TEST_MODE=true` (otherwise the route is a 404).
 * Truncates every table, drops every socket, clears in-memory state (rate-limit counters) and returns
 * a fresh single-use admin invite valid for 24 h.
 */
export function registerTestResetRoutes(
  app: FastifyInstance,
  { db, env, realtime, rateLimiter }: RouteDeps,
): void {
  const expected = env.HEARTH_TEST_TOKEN;

  app.post('/api/__test__/reset', async (request, reply) => {
    const token = request.headers[TEST_TOKEN_HEADER];
    if (expected === undefined || typeof token !== 'string' || !safeEqual(token, expected)) {
      throw new AppError('FORBIDDEN', 'Invalid test token');
    }

    await truncateAppTables(db);
    realtime.disconnectAll();
    rateLimiter.reset();
    const invite = await createInvite(db, {
      createdBy: null,
      grantsRole: 'admin',
      maxUses: 1,
      expiresInHours: 24,
    });
    return send(reply, TestResetResponse, { adminInviteCode: invite.code });
  });
}
