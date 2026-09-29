import { HealthResponse } from '@hearth/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { redactUrl } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { LIVEKIT_HEALTH_CACHE_MS } from '../src/livekit/health.js';
import { makeApp } from './helpers/app.js';
import { closeTestDb } from './helpers/db.js';
import { FakeVoiceBackend, unavailable } from './helpers/voice.js';

afterAll(closeTestDb);

describe('GET /api/health', () => {
  it('returns 200 with db and livekit ok', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', db: 'ok', livekit: 'ok' });
      expect(HealthResponse.parse(res.json())).toEqual({ status: 'ok', db: 'ok', livekit: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('LiveKit down with the DB up → 200 degraded; the result is cached for 10 s', async () => {
    const backend = new FakeVoiceBackend();
    const app = makeApp({ voiceBackend: backend });
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      // The boot reconcile's listRooms fails and records "down"; stop() waits for it.
      backend.fail.listRooms = [unavailable()];
      await app.ready();
      await app.voice.reconciler.stop();
      expect(backend.callsOf('listRooms')).toHaveLength(1);
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'degraded', db: 'ok', livekit: 'down' });
      // Cached: no new probe within 10 s, even though LiveKit is back.
      vi.setSystemTime(Date.now() + LIVEKIT_HEALTH_CACHE_MS - 1);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
        livekit: 'down',
      });
      expect(backend.callsOf('listRooms')).toHaveLength(1);
      vi.setSystemTime(Date.now() + 1); // stale now: the next request probes again
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
        status: 'ok',
        db: 'ok',
        livekit: 'ok',
      });
      expect(backend.callsOf('listRooms')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('returns 503 with db down when the database is unreachable', async () => {
    const unreachable = createDb('postgres://nobody:nothing@127.0.0.1:1/none', {
      connectionTimeoutMillis: 500,
    });
    const app = makeApp({ db: unreachable.db });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'degraded', db: 'down', livekit: 'ok' });
    } finally {
      await app.close();
      await unreachable.pool.end();
    }
  });

  it('a LiveKit probe that hangs counts as down after 2 s', async () => {
    const backend = new FakeVoiceBackend();
    const app = makeApp({ voiceBackend: backend });
    try {
      await app.ready();
      await app.voice.reconciler.stop();
      backend.onCall = () => new Promise(() => undefined); // never settles
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + LIVEKIT_HEALTH_CACHE_MS); // the boot reconcile's "ok" is stale
      const started = performance.now();
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'degraded', db: 'ok', livekit: 'down' });
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});

describe('request logging', () => {
  it('redacts invite codes from logged URLs', () => {
    expect(redactUrl('/api/invites/ABCDEFGH12345678/check')).toBe('/api/invites/[redacted]/check');
    expect(redactUrl('/api/me')).toBe('/api/me');
  });
});
