import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv, type Env } from '../../src/env.js';
import { unitDatabaseUrl } from './env.js';
import { testDb } from './db.js';

export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: 'silent',
    APP_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: unitDatabaseUrl(),
    UPLOAD_DIR: './data/test-uploads',
    LIVEKIT_URL: 'http://localhost:7880',
    LIVEKIT_PUBLIC_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'testkey',
    LIVEKIT_API_SECRET: 'test-only-secret-0123456789abcdef0123',
    HEARTH_TEST_MODE: 'false',
    ...overrides,
  });
}

/** Builds (but does not start) the app against the unit DB, with logging off. */
export function makeApp(
  options: { db?: Db; env?: Env; timings?: BuildAppOptions['timings'] } = {},
): FastifyInstance {
  return buildApp({
    db: options.db ?? testDb().db,
    env: options.env ?? testEnv(),
    logger: false,
    ...(options.timings === undefined ? {} : { timings: options.timings }),
  });
}
