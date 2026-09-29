import { LIMITS, RateLimitedDetails } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHANGE_PASSWORD_RATE_LIMIT } from '../src/plugins/rate-limit.js';
import { makeApp, testEnv } from './helpers/app.js';
import { api, expectError, insertUser, login, PASSWORD } from './helpers/auth.js';
import { closeTestDb, truncateAll } from './helpers/db.js';

const { max, windowMs } = LIMITS.rateLimits.login;

let app: FastifyInstance;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

function badLogin(target: FastifyInstance, ip = '127.0.0.1', forwardedFor?: string) {
  return target.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: ip,
    headers: {
      'x-requested-with': 'hearth',
      'content-type': 'application/json',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    payload: JSON.stringify({ username: 'nobody', password: 'wrong' }),
  });
}

describe('rate limits', () => {
  it(`the ${max + 1}th login in a minute gives 429 RATE_LIMITED with retryAfterMs`, async () => {
    for (let i = 0; i < max; i++) {
      expect((await badLogin(app)).statusCode).toBe(401);
    }
    const res = await badLogin(app);
    const body = expectError(res, 429, 'RATE_LIMITED');
    const { retryAfterMs } = RateLimitedDetails.parse(body.error.details);
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(windowMs);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

    // Even correct credentials are refused while limited.
    await insertUser('alice');
    const ok = await api(app, 'POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } });
    expectError(ok, 429, 'RATE_LIMITED');

    // Another IP is unaffected.
    expect((await badLogin(app, '10.0.0.2')).statusCode).toBe(401);
  });

  it(`the ${max + 1}th register in a minute gives 429 RATE_LIMITED`, async () => {
    const body = { inviteCode: 'NOPENOPENOPENOPE', username: 'alice', displayName: 'A', password: PASSWORD };
    for (let i = 0; i < max; i++) {
      expectError(await api(app, 'POST', '/api/auth/register', { body }), 400, 'INVITE_INVALID');
    }
    const res = await api(app, 'POST', '/api/auth/register', { body });
    const { retryAfterMs } = RateLimitedDetails.parse(expectError(res, 429, 'RATE_LIMITED').error.details);
    expect(retryAfterMs).toBeGreaterThan(0);
  });

  it('reset-password and the invite check are limited too', async () => {
    const body = { username: 'nobody', code: 'X', newPassword: 'long enough password' };
    for (let i = 0; i < max; i++) {
      expect((await api(app, 'POST', '/api/auth/reset-password', { body })).statusCode).toBe(401);
      expect((await api(app, 'GET', '/api/invites/ABC/check')).statusCode).toBe(200);
    }
    for (const res of [
      await api(app, 'POST', '/api/auth/reset-password', { body }),
      await api(app, 'GET', '/api/invites/ABC/check'),
    ]) {
      const { retryAfterMs } = RateLimitedDetails.parse(expectError(res, 429, 'RATE_LIMITED').error.details);
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(windowMs);
    }
    // Unlimited routes are not affected.
    expect((await api(app, 'GET', '/api/health')).statusCode).toBe(200);
  });

  it('keys on X-Forwarded-For only for requests from a TRUST_PROXY address', async () => {
    const proxyIp = '172.28.0.10';
    const proxied = makeApp({ env: testEnv({ TRUST_PROXY: `${proxyIp}, 10.0.0.0/8` }) });
    try {
      // From the trusted proxy: the forwarded client IP is the key.
      for (let i = 0; i < max; i++) {
        expect((await badLogin(proxied, proxyIp, '203.0.113.1')).statusCode).toBe(401);
      }
      expectError(await badLogin(proxied, proxyIp, '203.0.113.1'), 429, 'RATE_LIMITED');
      // Same proxy, different client → its own bucket (also via a CIDR entry).
      expect((await badLogin(proxied, proxyIp, '203.0.113.2')).statusCode).toBe(401);
      expect((await badLogin(proxied, '10.1.2.3', '203.0.113.3')).statusCode).toBe(401);

      // A direct hit from an untrusted address: a forged X-Forwarded-For does not change the key.
      const direct = '198.51.100.7';
      for (let i = 0; i < max; i++) {
        expect((await badLogin(proxied, direct, `203.0.113.${i + 10}`)).statusCode).toBe(401);
      }
      expectError(await badLogin(proxied, direct, '203.0.113.99'), 429, 'RATE_LIMITED');
      expectError(await badLogin(proxied, direct), 429, 'RATE_LIMITED');
      // …and cannot spend another client's budget either: 203.0.113.2 still has requests left.
      expect((await badLogin(proxied, proxyIp, '203.0.113.2')).statusCode).toBe(401);
    } finally {
      await proxied.close();
    }
  });

  it('with TRUST_PROXY unset, X-Forwarded-For is ignored even from loopback', async () => {
    for (let i = 0; i < max; i++) {
      expect((await badLogin(app, '127.0.0.1', `203.0.113.${i + 10}`)).statusCode).toBe(401);
    }
    expectError(await badLogin(app, '127.0.0.1', '203.0.113.99'), 429, 'RATE_LIMITED');
  });

  it(`the ${CHANGE_PASSWORD_RATE_LIMIT.max + 1}th password change in a minute → 429 with retryAfterMs, per user`, async () => {
    expect(CHANGE_PASSWORD_RATE_LIMIT).toEqual({ max: 10, windowMs: 60_000 });
    await insertUser('alice');
    await insertUser('bob');
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const change = (cookie: string, currentPassword: string) =>
      api(app, 'POST', '/api/me/password', {
        cookie,
        body: { currentPassword, newPassword: 'a brand new passphrase' },
      });

    for (let i = 0; i < CHANGE_PASSWORD_RATE_LIMIT.max; i++) {
      expectError(await change(alice, 'wrong password'), 401, 'INVALID_CREDENTIALS');
    }
    // Refused before the password is even checked: the correct one changes nothing.
    const res = await change(alice, PASSWORD);
    const body = expectError(res, 429, 'RATE_LIMITED');
    const { retryAfterMs } = RateLimitedDetails.parse(body.error.details);
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(CHANGE_PASSWORD_RATE_LIMIT.windowMs);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await api(app, 'GET', '/api/me', { cookie: alice })).statusCode).toBe(200);
    expect(
      (await api(app, 'POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } }))
        .statusCode,
    ).toBe(200);

    // Another user (same IP) has their own window.
    expect((await change(bob, PASSWORD)).statusCode).toBe(204);
  });
});
