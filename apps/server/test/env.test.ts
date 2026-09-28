import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../src/env.js';

const SECRET = 'test-only-secret-0123456789abcdef0123';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  LIVEKIT_URL: 'http://localhost:7880',
  LIVEKIT_PUBLIC_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: SECRET,
};

describe('loadEnv', () => {
  it('parses a valid env with defaults and coercion', () => {
    const env = loadEnv({ ...base, PORT: '3100', MIGRATE_ON_START: 'true', HEARTH_TEST_TOKEN: '' });
    expect(env.PORT).toBe(3100);
    expect(env.MIGRATE_ON_START).toBe(true);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.SESSION_TTL_DAYS).toBe(30);
    expect(env.MAX_USERS).toBe(25);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.HEARTH_TEST_MODE).toBe(false);
    expect(env.HEARTH_TEST_TOKEN).toBeUndefined();
  });

  it('splits APP_ORIGIN on commas', () => {
    const env = loadEnv({ ...base, APP_ORIGIN: 'http://localhost:5173, http://localhost:8080,' });
    expect(env.APP_ORIGIN).toEqual(['http://localhost:5173', 'http://localhost:8080']);
  });

  it('requires a test token when test mode is on', () => {
    expect(() => loadEnv({ ...base, HEARTH_TEST_MODE: 'true' })).toThrow(/HEARTH_TEST_TOKEN/);
  });

  it('refuses production with test mode', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', HEARTH_TEST_MODE: 'true', HEARTH_TEST_TOKEN: 't' }),
    ).toThrow(/HEARTH_TEST_MODE/);
  });

  it('rejects a LiveKit secret shorter than 32 characters without printing it', () => {
    const short = 'too-short-secret';
    let caught: unknown;
    try {
      loadEnv({ ...base, LIVEKIT_API_SECRET: short });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvError);
    const message = (caught as EnvError).message;
    expect(message).toContain('LIVEKIT_API_SECRET');
    expect(message).not.toContain(short);
  });

  it('lists every invalid key', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'loud', PORT: 'abc', DATABASE_URL: undefined })).toThrow(
      /LOG_LEVEL[\s\S]*PORT|PORT[\s\S]*LOG_LEVEL/,
    );
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
