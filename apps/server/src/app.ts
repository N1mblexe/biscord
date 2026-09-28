import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import { registerCsrf } from './lib/csrf.js';
import { registerErrorHandlers } from './lib/errors.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  db: Db;
  env: Env;
  /** `false` disables logging (tests). Defaults to `true`. */
  logger?: boolean;
}

function loggerOptions(env: Env, enabled: boolean): FastifyServerOptions['logger'] {
  if (!enabled) return false;
  return {
    level: env.LOG_LEVEL,
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

/** Builds the Fastify instance with every plugin and route registered. Does not listen. */
export function buildApp({ db, env, logger = true }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(env, logger) });

  registerErrorHandlers(app);
  registerCsrf(app);
  registerHealthRoutes(app, { db });

  return app;
}
