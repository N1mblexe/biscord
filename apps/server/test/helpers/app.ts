import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv, type Env } from '../../src/env.js';
import { unitDatabaseUrl } from './env.js';
import { testDb } from './db.js';
import { FakeVoiceBackend } from './voice.js';

export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: 'silent',
    APP_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: unitDatabaseUrl(),
    // Absolute, inside the run's temp dir (see global-setup.ts); upload tests pass their own.
    UPLOAD_DIR: path.join(inject('uploadRoot'), 'default'),
    UPLOAD_GC_INTERVAL_MINUTES: '0',
    // The free-space check depends on the machine; its tests set a threshold (and a fake statfs).
    UPLOAD_MIN_FREE_MB: '0',
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
  options: {
    db?: Db;
    env?: Env;
    timings?: BuildAppOptions['timings'];
    statfs?: BuildAppOptions['statfs'];
    /** Defaults to a fresh `FakeVoiceBackend` (no LiveKit needed); pass a real one for container tests. */
    voiceBackend?: BuildAppOptions['voiceBackend'];
  } = {},
): FastifyInstance {
  return buildApp({
    db: options.db ?? testDb().db,
    env: options.env ?? testEnv(),
    logger: false,
    ...(options.timings === undefined ? {} : { timings: options.timings }),
    ...(options.statfs === undefined ? {} : { statfs: options.statfs }),
    voiceBackend: options.voiceBackend ?? new FakeVoiceBackend(),
  });
}
