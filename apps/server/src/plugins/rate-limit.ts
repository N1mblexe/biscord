import rateLimit from '@fastify/rate-limit';
import type { FastifyContextConfig, FastifyInstance } from 'fastify';
import { LIMITS } from '@hearth/shared';
import { AppError } from '../lib/errors.js';

export interface RateLimiter {
  /** Route `config` for the auth endpoints (register, login, reset-password, invite check): 10/min/IP. */
  readonly authRoute: FastifyContextConfig;
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
    reset: () => {
      generation += 1;
    },
  };
}
