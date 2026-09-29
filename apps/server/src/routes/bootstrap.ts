import type { FastifyInstance } from 'fastify';
import { BootstrapResponse } from '@hearth/shared';
import { send } from '../lib/respond.js';
import { toChannel, toDmChannel, toMe, toPublicUser } from '../lib/serialize.js';
import { authOf } from '../plugins/auth.js';
import { listChannels } from '../services/channels.js';
import { listDmsForUser } from '../services/dms.js';
import { listReadStates } from '../services/reads.js';
import { listUsers } from '../services/users.js';
import type { RouteDeps } from './deps.js';

/**
 * CONTRACTS B.4 row 12, staged: `voice` stays empty until Phase 6. `readStates` covers every text channel
 * and the caller's DMs; `onlineUserIds` is the in-memory presence (B.5a rule 6).
 */
export function registerBootstrapRoutes(
  app: FastifyInstance,
  { db, env, guards, realtime }: RouteDeps,
): void {
  app.get('/api/bootstrap', { preHandler: guards.requireUser }, async (request, reply) => {
    const { user } = authOf(request);
    const [users, channels, dms, readStates] = await Promise.all([
      listUsers(db),
      listChannels(db),
      listDmsForUser(db, user.id),
      listReadStates(db, user.id),
    ]);
    return send(reply, BootstrapResponse, {
      me: toMe(user),
      users: users.map(toPublicUser),
      channels: channels.map(toChannel),
      dms: dms.map((dm) => toDmChannel(dm.channelId, dm.otherUserId)),
      readStates,
      voice: {}, // Phase 6
      onlineUserIds: realtime.onlineUserIds(),
      livekitUrl: env.LIVEKIT_PUBLIC_URL,
    });
  });
}
