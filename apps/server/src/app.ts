import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { LIMITS, type SocketData } from '@hearth/shared';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import { registerCsrf } from './lib/csrf.js';
import { createLiveKitBackend, type VoiceBackend } from './livekit/client.js';
import { createLiveKitHealth } from './livekit/health.js';
import { createReconciler, type Reconciler } from './livekit/reconcile.js';
import { registerErrorHandlers } from './lib/errors.js';
import { registerAuth } from './plugins/auth.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { createRealtime } from './realtime/io.js';
import { registerTyping } from './realtime/typing.js';
import { createVoiceState, registerVoiceEvents, type VoiceState } from './realtime/voice-state.js';
import { registerAdminInviteRoutes } from './routes/admin-invites.js';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerChannelRoutes } from './routes/channels.js';
import type { RouteDeps } from './routes/deps.js';
import { registerDmRoutes } from './routes/dms.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLiveKitWebhookRoute } from './routes/livekit-webhook.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerReactionRoutes } from './routes/reactions.js';
import { registerReadRoutes } from './routes/reads.js';
import { registerTestResetRoutes } from './routes/test-reset.js';
import { registerUserRoutes } from './routes/users.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { createLifecycle } from './services/lifecycle.js';
import { warmUpDummyHash } from './services/passwords.js';
import { runUploadGc, startGcScheduler, type GcScheduler } from './storage/gc.js';
import { createStorage, resolveUploadDir, type StatfsFn } from './storage/paths.js';

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
  /** Test-only: replaces `fs.statfs` for the free-space check (B.7a rule 8), to fake a full disk. */
  statfs?: StatfsFn;
  /** Test-only: replaces the LiveKit `RoomServiceClient` (a fake, or one with other credentials). */
  voiceBackend?: VoiceBackend;
  /** Test-only hooks into otherwise unreachable windows (never set outside tests). */
  testHooks?: {
    /** Runs between a socket handshake's session lookup and the socket joining its rooms. */
    afterSocketHandshakeResolved?: (data: SocketData) => Promise<void>;
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The voice state and its reconcile loop; tests drive them directly. */
    voice: { state: VoiceState; reconciler: Reconciler };
  }
}

/**
 * A route parameter may be this long (raw, percent-encoded): `/attachments/:id/:filename` carries a filename
 * of up to 255 UTF-8 bytes, i.e. up to 765 characters encoded. Fastify's default is 100.
 */
export const MAX_PARAM_LENGTH = 1024;

/** `%XX` → the byte as a char (enough to compare ASCII path segments); anything else is kept. */
function decodePercent(segment: string): string {
  return segment.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Invite codes travel in the check URL (B.4 row 6); keep them out of request logs. The router decodes
 * percent-encoding, so `/%61pi/%69nvites/<code>/check` reaches the same route: the path segments are compared
 * decoded (and case-insensitively), and the code segment is replaced whatever its spelling.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const segments = path.split('/');
  // ['', 'api', 'invites', '<code>', ...]
  if (
    segments.length >= 4 &&
    decodePercent(segments[1] ?? '').toLowerCase() === 'api' &&
    decodePercent(segments[2] ?? '').toLowerCase() === 'invites'
  ) {
    segments[3] = '[redacted]';
    return segments.join('/') + (queryAt === -1 ? '' : url.slice(queryAt));
  }
  return url;
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
export function buildApp({
  db,
  env,
  logger = true,
  timings = {},
  statfs,
  voiceBackend = createLiveKitBackend(env),
  testHooks = {},
}: BuildAppOptions): FastifyInstance {
  // `false`, or the list of proxy IPs/CIDRs from TRUST_PROXY (never `true`, see env.ts).
  const app = Fastify({
    logger: loggerOptions(env, logger),
    trustProxy: env.TRUST_PROXY,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
  });
  // Compute the login dummy hash before serving, so the first unknown-user login is not slower than others.
  app.addHook('onReady', warmUpDummyHash);

  // B.7a rule 1: create tmp/ and avatars/ before serving; an unwritable UPLOAD_DIR fails the startup.
  const storage = createStorage(
    resolveUploadDir(env.UPLOAD_DIR),
    app.log,
    statfs === undefined ? {} : { statfs },
  );
  app.addHook('onReady', () => storage.init());
  let gc: GcScheduler | null = null;
  if (env.UPLOAD_GC_INTERVAL_MINUTES > 0) {
    app.addHook('onReady', (done) => {
      gc = startGcScheduler(
        env.UPLOAD_GC_INTERVAL_MINUTES * 60_000,
        () => runUploadGc({ db, storage, log: app.log }),
        app.log,
      );
      done();
    });
    app.addHook('onClose', async () => {
      await gc?.stop();
    });
  }

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
    ...(testHooks.afterSocketHandshakeResolved === undefined
      ? {}
      : { afterHandshakeResolved: testHooks.afterSocketHandshakeResolved }),
  });
  const typing = registerTyping({
    db,
    realtime,
    log: app.log,
    ...(timings.typingThrottleMs === undefined ? {} : { throttleMs: timings.typingThrottleMs }),
  });
  const livekitHealth = createLiveKitHealth(voiceBackend, app.log);
  const voice = createVoiceState({ realtime, backend: voiceBackend, log: app.log });
  const voiceEvents = registerVoiceEvents({ realtime, voice, log: app.log });
  // B.6a rule 4: reconcile at boot and every VOICE_RECONCILE_MS; stopped (and awaited) on close.
  const reconciler = createReconciler({
    db,
    backend: voiceBackend,
    voice,
    health: livekitHealth,
    log: app.log,
  });
  app.decorate('voice', { state: voice, reconciler });
  app.addHook('onReady', (done) => {
    reconciler.start(env.VOICE_RECONCILE_MS);
    done();
  });
  app.addHook('onClose', () => reconciler.stop());
  registerHealthRoutes(app, { db, livekitHealth });
  const lifecycle = createLifecycle({
    db,
    maxUsers: env.MAX_USERS,
    realtime,
    voice,
    voiceBackend,
    livekitHealth,
    storage,
    log: app.log,
  });

  const deps: RouteDeps = {
    db,
    env,
    guards,
    rateLimiter,
    realtime,
    typing,
    storage,
    voice,
    voiceEvents,
    voiceBackend,
    livekitHealth,
    lifecycle,
  };
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
    registerVoiceRoutes(instance, deps);
    registerLiveKitWebhookRoute(instance, deps);
    if (env.HEARTH_TEST_MODE) registerTestResetRoutes(instance, deps);
    // Multipart parsing only where uploads are accepted: every other route keeps refusing it (415).
    void instance.register(async (uploads) => {
      await uploads.register(fastifyMultipart, {
        // Per-call limits in `receiveUpload` take precedence; these are the strict defaults.
        limits: { fileSize: LIMITS.uploadMaxBytes, files: 1, fields: 0, parts: 1 },
      });
      registerAttachmentRoutes(uploads, deps);
      registerAvatarRoutes(uploads, deps);
    });
    done();
  });

  return app;
}
