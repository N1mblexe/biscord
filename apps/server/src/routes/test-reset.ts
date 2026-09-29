import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TestResetResponse, TestSeedMessagesRequest, TestSeedMessagesResponse } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import { channels } from '../db/schema.js';
import { truncateAppTables } from '../db/tables.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { parse } from '../lib/validate.js';
import { createInvite } from '../services/invites.js';
import { seedMessages } from '../services/messages.js';
import { findUserById } from '../services/users.js';
import type { RouteDeps } from './deps.js';

export const TEST_TOKEN_HEADER = 'x-test-token';

/**
 * CONTRACTS B.4 rows 39–40. Only registered when `HEARTH_TEST_MODE=true` (otherwise the routes are a 404).
 * Both require the `X-Test-Token` header (403 FORBIDDEN otherwise).
 */
export function registerTestResetRoutes(
  app: FastifyInstance,
  { db, env, realtime, rateLimiter, typing, storage }: RouteDeps,
): void {
  const expected = env.HEARTH_TEST_TOKEN;

  const assertTestToken = (request: FastifyRequest): void => {
    const token = request.headers[TEST_TOKEN_HEADER];
    if (expected === undefined || typeof token !== 'string' || !safeEqual(token, expected)) {
      throw new AppError('FORBIDDEN', 'Invalid test token');
    }
  };

  /**
   * Truncates every table, drops every socket, clears in-memory state (every rate-limit counter: auth
   * routes per IP and message sends per user; presence and its pending offline timers; the typing throttle and per-user buckets),
   * empties this server's UPLOAD_DIR (only the tmp/, avatars/ and yyyy/ trees it creates) and returns a
   * fresh single-use admin invite valid for 24 h.
   */
  app.post('/api/__test__/reset', async (request, reply) => {
    assertTestToken(request);
    await truncateAppTables(db);
    await storage.clear();
    realtime.disconnectAll();
    // After the disconnects, which started offline grace timers that must not fire into the next test.
    realtime.resetPresence();
    typing.clear();
    rateLimiter.reset();
    const invite = await createInvite(db, {
      createdBy: null,
      grantsRole: 'admin',
      maxUses: 1,
      expiresInHours: 24,
    });
    return send(reply, TestResetResponse, { adminInviteCode: invite.code });
  });

  /** Inserts `"<prefix> 1".."<prefix> n"` directly: no broadcast, no rate limit. */
  app.post('/api/__test__/seed-messages', async (request, reply) => {
    assertTestToken(request);
    const input = parse(TestSeedMessagesRequest, request.body);
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, input.channelId));
    if (channel === undefined) throw new AppError('NOT_FOUND', 'Channel not found');
    const author = await findUserById(db, input.authorId);
    if (author === null) throw new AppError('NOT_FOUND', 'User not found');

    const { firstId, lastId } = await seedMessages(db, {
      ...input,
      channelId: channel.id,
      authorId: author.id,
    });
    return send(reply, TestSeedMessagesResponse, { firstId: String(firstId), lastId: String(lastId) });
  });
}
