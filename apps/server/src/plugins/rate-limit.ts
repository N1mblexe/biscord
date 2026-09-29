import rateLimit from '@fastify/rate-limit';
import type { FastifyContextConfig, FastifyInstance } from 'fastify';
import { LIMITS } from '@hearth/shared';
import { AppError } from '../lib/errors.js';

/** B.6a rule 2 (not in the shared LIMITS; server-side only). */
export const VOICE_TOKEN_RATE_LIMIT = { max: 30, windowMs: 60_000 } as const;

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
    reset: () => {
      generation += 1;
    },
  };
}
