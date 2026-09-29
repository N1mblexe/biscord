import rateLimit from '@fastify/rate-limit';
import type { FastifyContextConfig, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LIMITS } from '@hearth/shared';
import { AppError } from '../lib/errors.js';

/** B.6a rule 2 (not in the shared LIMITS; server-side only). */
export const VOICE_TOKEN_RATE_LIMIT = { max: 30, windowMs: 60_000 } as const;
/** Phase 8 rate-limit review: reaction PUT + DELETE together, per user. */
export const REACTION_RATE_LIMIT = { max: 30, windowMs: 10_000 } as const;
/** B.7b rule 7: `POST /me/password` (row 9), per user; each attempt costs an argon2 verify. */
export const CHANGE_PASSWORD_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const;
/** Phase 8 rate-limit review: every admin-only mutating route together, per admin. */
export const ADMIN_MUTATION_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

/** Above this many tracked users, expired windows are swept on the next hit. */
const WINDOW_SWEEP_THRESHOLD = 1_000;

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface SharedWindowLimiter {
  readonly preHandler: PreHandler;
  clear(): void;
}

/**
 * A fixed window per authenticated user, **shared by every route that uses the returned preHandler**
 * (`@fastify/rate-limit` keeps one store per route, so it can't count several routes together). Runs after
 * the auth guard in the route's `preHandler` list. The excess gets the same 429 as the plugin: `Retry-After`
 * and `details.retryAfterMs`.
 */
function sharedWindowLimiter(
  limit: { max: number; windowMs: number },
  now: () => number = Date.now,
): SharedWindowLimiter {
  const windows = new Map<string, { start: number; count: number }>();

  const sweep = (at: number): void => {
    for (const [key, window] of windows) if (at - window.start >= limit.windowMs) windows.delete(key);
  };

  const preHandler: PreHandler = (request, reply) => {
    const key = request.auth?.user.id;
    // The auth guard runs first; an anonymous request never gets here.
    if (key === undefined) return Promise.reject(new AppError('UNAUTHENTICATED', 'Authentication required'));
    const at = now();
    const current = windows.get(key);
    if (current === undefined || at - current.start >= limit.windowMs) {
      if (windows.size >= WINDOW_SWEEP_THRESHOLD) sweep(at);
      windows.set(key, { start: at, count: 1 });
      return Promise.resolve();
    }
    current.count += 1;
    if (current.count <= limit.max) return Promise.resolve();
    const retryAfterMs = Math.max(1, current.start + limit.windowMs - at);
    void reply.header('retry-after', Math.ceil(retryAfterMs / 1000));
    return Promise.reject(
      new AppError('RATE_LIMITED', 'Too many requests, try again later', { retryAfterMs }),
    );
  };

  return {
    preHandler,
    clear: () => {
      windows.clear();
    },
  };
}

export interface RateLimiter {
  /** Route `config` for the auth endpoints (register, login, reset-password, invite check): 10/min/IP. */
  readonly authRoute: FastifyContextConfig;
  /**
   * Route `config` for sending messages: 10 per 10 s per **user**. Runs as a preHandler, after
   * `requireUser`, so the key is the authenticated user id (anonymous requests are refused before it).
   */
  readonly messageSend: FastifyContextConfig;
  /** Route `config` for uploads (row 27): 20 per minute per **user**, as a preHandler like `messageSend`. */
  readonly upload: FastifyContextConfig;
  /** Route `config` for voice tokens (row 29, B.6a rule 2): 30 per minute per **user**, as a preHandler. */
  readonly voiceToken: FastifyContextConfig;
  /** Route `config` for changing the password (row 9): 10 per minute per **user**, as a preHandler. */
  readonly changePassword: FastifyContextConfig;
  /** preHandler (after `requireUser`) for reaction PUT/DELETE (rows 24–25): 30 per 10 s per user, both together. */
  readonly reaction: PreHandler;
  /**
   * preHandler (after `requireAdmin`) for every admin-only mutation (rows 15–18, 31, 33–38): 60 per minute
   * per admin, all routes together.
   */
  readonly adminMutation: PreHandler;
  /** Forgets every counter (test reset). Old keys simply age out of the in-memory store. */
  reset(): void;
}

/**
 * Registers `@fastify/rate-limit` with `global: false`; routes opt in through their `config`.
 * Must be registered before the routes that use it (they are registered as plugins after it).
 * A 429 becomes the shared `RATE_LIMITED` body with `details.retryAfterMs`.
 */
export function registerRateLimit(app: FastifyInstance): RateLimiter {
  let generation = 0;
  const reactions = sharedWindowLimiter(REACTION_RATE_LIMIT);
  const adminMutations = sharedWindowLimiter(ADMIN_MUTATION_RATE_LIMIT);

  void app.register(rateLimit, {
    global: false,
    // `request.ip` honours TRUST_PROXY (X-Forwarded-For only from the listed proxies). The generation prefix lets the test reset start from zero.
    keyGenerator: (request) => `${generation}|${request.ip}`,
    errorResponseBuilder: (_request, context) =>
      new AppError('RATE_LIMITED', 'Too many requests, try again later', {
        retryAfterMs: Math.max(0, Math.ceil(context.ttl)),
      }),
  });

  return {
    authRoute: {
      rateLimit: { max: LIMITS.rateLimits.login.max, timeWindow: LIMITS.rateLimits.login.windowMs },
    },
    messageSend: {
      rateLimit: {
        max: LIMITS.rateLimits.messageSend.max,
        timeWindow: LIMITS.rateLimits.messageSend.windowMs,
        hook: 'preHandler',
        keyGenerator: (request) => `${generation}|user:${request.auth?.user.id ?? request.ip}`,
      },
    },
    upload: {
      rateLimit: {
        max: LIMITS.rateLimits.uploads.max,
        timeWindow: LIMITS.rateLimits.uploads.windowMs,
        hook: 'preHandler',
        keyGenerator: (request) => `${generation}|upload:${request.auth?.user.id ?? request.ip}`,
      },
    },
    voiceToken: {
      rateLimit: {
        max: VOICE_TOKEN_RATE_LIMIT.max,
        timeWindow: VOICE_TOKEN_RATE_LIMIT.windowMs,
        hook: 'preHandler',
        keyGenerator: (request) => `${generation}|voice:${request.auth?.user.id ?? request.ip}`,
      },
    },
    changePassword: {
      rateLimit: {
        max: CHANGE_PASSWORD_RATE_LIMIT.max,
        timeWindow: CHANGE_PASSWORD_RATE_LIMIT.windowMs,
        hook: 'preHandler',
        keyGenerator: (request) => `${generation}|password:${request.auth?.user.id ?? request.ip}`,
      },
    },
    reaction: reactions.preHandler,
    adminMutation: adminMutations.preHandler,
    reset: () => {
      generation += 1;
      reactions.clear();
      adminMutations.clear();
    },
  };
}
