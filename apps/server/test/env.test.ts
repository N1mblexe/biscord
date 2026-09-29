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
    expect(env.UPLOAD_DIR).toBe('./data/uploads');
    expect(env.UPLOAD_GC_INTERVAL_MINUTES).toBe(60);
    expect(env.UPLOAD_MIN_FREE_MB).toBe(2048);
  });

  it('VOICE_RECONCILE_MS: default 60000, 1000..3600000', () => {
    expect(loadEnv(base).VOICE_RECONCILE_MS).toBe(60_000);
    expect(loadEnv({ ...base, VOICE_RECONCILE_MS: '5000' }).VOICE_RECONCILE_MS).toBe(5_000);
    for (const bad of ['0', '999', '3600001', '1.5', 'often']) {
      expect(() => loadEnv({ ...base, VOICE_RECONCILE_MS: bad })).toThrow(/VOICE_RECONCILE_MS/);
    }
  });

  it('UPLOAD_MIN_FREE_MB: 0 disables, negatives and non-integers are refused', () => {
    expect(loadEnv({ ...base, UPLOAD_MIN_FREE_MB: '0' }).UPLOAD_MIN_FREE_MB).toBe(0);
    expect(loadEnv({ ...base, UPLOAD_MIN_FREE_MB: '512' }).UPLOAD_MIN_FREE_MB).toBe(512);
    for (const bad of ['-1', '1.5', 'lots']) {
      expect(() => loadEnv({ ...base, UPLOAD_MIN_FREE_MB: bad })).toThrow(/UPLOAD_MIN_FREE_MB/);
    }
  });

  it('UPLOAD_GC_INTERVAL_MINUTES: 0 disables, negatives and non-integers are refused', () => {
    expect(loadEnv({ ...base, UPLOAD_GC_INTERVAL_MINUTES: '0' }).UPLOAD_GC_INTERVAL_MINUTES).toBe(0);
    expect(loadEnv({ ...base, UPLOAD_GC_INTERVAL_MINUTES: '15' }).UPLOAD_GC_INTERVAL_MINUTES).toBe(15);
    for (const bad of ['-1', '1.5', 'soon']) {
      expect(() => loadEnv({ ...base, UPLOAD_GC_INTERVAL_MINUTES: bad })).toThrow(
        /UPLOAD_GC_INTERVAL_MINUTES/,
      );
    }
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

  describe('TRUST_PROXY', () => {
    it('false, empty or unset → trust no proxy', () => {
      expect(loadEnv(base).TRUST_PROXY).toBe(false);
      expect(loadEnv({ ...base, TRUST_PROXY: '' }).TRUST_PROXY).toBe(false);
      expect(loadEnv({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
      expect(loadEnv({ ...base, TRUST_PROXY: ' FALSE ' }).TRUST_PROXY).toBe(false);
    });

    it('parses a comma-separated list of IPs and CIDRs', () => {
      expect(loadEnv({ ...base, TRUST_PROXY: '172.28.0.10' }).TRUST_PROXY).toEqual(['172.28.0.10']);
      expect(
        loadEnv({ ...base, TRUST_PROXY: ' 172.28.0.10, 10.0.0.0/8 ,::1, fd00::/8,' }).TRUST_PROXY,
      ).toEqual(['172.28.0.10', '10.0.0.0/8', '::1', 'fd00::/8']);
    });

    it('refuses the literal true with a clear message', () => {
      for (const value of ['true', 'TRUE', ' true ']) {
        expect(() => loadEnv({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY: "true" is not allowed/);
      }
    });

    it('refuses anything that is not an IP or CIDR', () => {
      for (const value of [
        '1',
        'yes',
        'loopback',
        'caddy',
        '10.0.0.0/33',
        '10.0.0.0/',
        '10.0.0.0/8/8',
        '::1/129',
        '256.0.0.1',
        '172.28.0.10,nope',
        ',',
      ]) {
        expect(() => loadEnv({ ...base, TRUST_PROXY: value }), value).toThrow(/TRUST_PROXY/);
      }
    });
  });

  it('lists every invalid key', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'loud', PORT: 'abc', DATABASE_URL: undefined })).toThrow(
      /LOG_LEVEL[\s\S]*PORT|PORT[\s\S]*LOG_LEVEL/,
    );
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
