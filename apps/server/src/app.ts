import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import { registerCsrf } from './lib/csrf.js';
import { registerErrorHandlers } from './lib/errors.js';
import { registerAuth } from './plugins/auth.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { createRealtime } from './realtime/io.js';
import { registerTyping } from './realtime/typing.js';
import { registerAdminInviteRoutes } from './routes/admin-invites.js';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerChannelRoutes } from './routes/channels.js';
import type { RouteDeps } from './routes/deps.js';
import { registerDmRoutes } from './routes/dms.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerReactionRoutes } from './routes/reactions.js';
import { registerReadRoutes } from './routes/reads.js';
import { registerTestResetRoutes } from './routes/test-reset.js';
import { registerUserRoutes } from './routes/users.js';
import { warmUpDummyHash } from './services/passwords.js';

export interface BuildAppOptions {
  db: Db;
  env: Env;
  /** `false` disables logging (tests). Defaults to `true`. */
  logger?: boolean;
  /**
   * Test-only overrides of the realtime timings, so tests don't wait out the real ones. Production code
   * never passes these (they are not read from the environment).
   */
  timings?: {
    /** Default `LIMITS.presenceOfflineGraceMs` (3 s). */
    presenceOfflineGraceMs?: number;
    /** Default `TYPING_BROADCAST_THROTTLE_MS` (2 s). */
    typingThrottleMs?: number;
  };
}

/** Invite codes travel in the check URL (B.4 row 6); keep them out of request logs. */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/^(\/api\/invites\/)[^/?]+/, '$1[redacted]');
}

function loggerOptions(env: Env, enabled: boolean): FastifyServerOptions['logger'] {
  if (!enabled) return false;
  return {
    level: env.LOG_LEVEL,
    serializers: {
      // Fastify's default request serializer, with the URL redacted. At runtime `req` is the FastifyRequest.
      req: (req) => ({
        method: req.method,
        url: redactUrl(req.url),
        host: req.headers.host,
        remoteAddress: 'ip' in req && typeof req.ip === 'string' ? req.ip : req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
      }),
    },
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-test-token"]'],
      censor: '[redacted]',
    },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

/**
 * Builds the Fastify instance with every plugin, route and the Socket.IO server attached. Does not listen.
 * `app.inject` works as soon as it resolves `ready()`; sockets need `app.listen`.
 */
export function buildApp({ db, env, logger = true, timings = {} }: BuildAppOptions): FastifyInstance {
  // `false`, or the list of proxy IPs/CIDRs from TRUST_PROXY (never `true`, see env.ts).
  const app = Fastify({ logger: loggerOptions(env, logger), trustProxy: env.TRUST_PROXY });
  // Compute the login dummy hash before serving, so the first unknown-user login is not slower than others.
  app.addHook('onReady', warmUpDummyHash);

  registerErrorHandlers(app);
  registerCsrf(app);
  const guards = registerAuth(app, { db, env });
  const rateLimiter = registerRateLimit(app);
  const realtime = createRealtime(app, {
    db,
    env,
    ...(timings.presenceOfflineGraceMs === undefined
      ? {}
      : { presenceOfflineGraceMs: timings.presenceOfflineGraceMs }),
  });
  const typing = registerTyping({
    db,
    realtime,
    log: app.log,
    ...(timings.typingThrottleMs === undefined ? {} : { throttleMs: timings.typingThrottleMs }),
  });
  registerHealthRoutes(app, { db });

  const deps: RouteDeps = { db, env, guards, rateLimiter, realtime, typing };
  // Routes live in a child context loaded after @fastify/rate-limit, whose onRoute hook reads `config.rateLimit`.
  void app.register((instance, _opts, done) => {
    registerAuthRoutes(instance, deps);
    registerMeRoutes(instance, deps);
    registerUserRoutes(instance, deps);
    registerBootstrapRoutes(instance, deps);
    registerChannelRoutes(instance, deps);
    registerDmRoutes(instance, deps);
    registerMessageRoutes(instance, deps);
    registerReactionRoutes(instance, deps);
    registerReadRoutes(instance, deps);
    registerAdminInviteRoutes(instance, deps);
    registerAdminUserRoutes(instance, deps);
    if (env.HEARTH_TEST_MODE) registerTestResetRoutes(instance, deps);
    done();
  });

  return app;
}
