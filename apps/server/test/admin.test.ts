import { InviteResponse, InvitesResponse, ResetCodeResponse } from '@hearth/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passwordResetCodes } from '../src/db/schema.js';
import { CROCKFORD_ALPHABET } from '../src/lib/crypto.js';
import { makeApp } from './helpers/app.js';
import {
  api,
  expectError,
  getInvite,
  insertInvite,
  insertUser,
  login,
  PASSWORD,
  registerViaApi,
  sessionCount,
} from './helpers/auth.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

const CODE_RE = (length: number): RegExp => new RegExp(`^[${CROCKFORD_ALPHABET}]{${length}}$`);
const HOUR_MS = 3600 * 1000;

let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  adminId = (await insertUser('admin', { role: 'admin' })).id;
  await insertUser('member');
  adminCookie = await login(app, 'admin');
  memberCookie = await login(app, 'member');
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

describe('admin access control', () => {
  const routes = (): ['GET' | 'POST' | 'DELETE', string][] => [
    ['GET', '/api/admin/invites'],
    ['POST', '/api/admin/invites'],
    ['DELETE', '/api/admin/invites/00000000-0000-4000-8000-000000000000'],
    ['POST', `/api/admin/users/${adminId}/reset-code`],
  ];

  it('non-admin → 403 FORBIDDEN', async () => {
    for (const [method, url] of routes()) {
      expectError(await api(app, method, url, { cookie: memberCookie }), 403, 'FORBIDDEN');
    }
  });

  it('anonymous → 401 UNAUTHENTICATED', async () => {
    for (const [method, url] of routes()) {
      expectError(await api(app, method, url), 401, 'UNAUTHENTICATED');
    }
  });
});

describe('admin invites', () => {
  it('POST with no body creates a 16-char invite with defaults (1 use, 168 h)', async () => {
    const before = Date.now();
    const res = await api(app, 'POST', '/api/admin/invites', { cookie: adminCookie });
    expect(res.statusCode, res.payload).toBe(201);
    const { invite } = InviteResponse.parse(res.json());
    expect(invite.code).toMatch(CODE_RE(16));
    expect(invite).toMatchObject({ maxUses: 1, uses: 0, revokedAt: null, createdBy: adminId });
    const hours = (Date.parse(invite.expiresAt) - before) / HOUR_MS;
    expect(hours).toBeGreaterThan(167.9);
    expect(hours).toBeLessThan(168.1);
    // Admin-created invites grant member.
    expect((await getInvite(invite.id)).grantsRole).toBe('member');
  });

  it('POST honours maxUses and expiresInHours, and validates them', async () => {
    const res = await api(app, 'POST', '/api/admin/invites', {
      cookie: adminCookie,
      body: { maxUses: 5, expiresInHours: 2 },
    });
    expect(res.statusCode).toBe(201);
    expect(InviteResponse.parse(res.json()).invite.maxUses).toBe(5);

    for (const body of [{ maxUses: 0 }, { maxUses: 26 }, { expiresInHours: 721 }, { maxUses: 1.5 }]) {
      expectError(
        await api(app, 'POST', '/api/admin/invites', { cookie: adminCookie, body }),
        400,
        'VALIDATION',
      );
    }
  });

  it('GET lists invites newest first', async () => {
    const first = await insertInvite();
    const second = await insertInvite();
    await testDb().db.execute(
      sql`update invites set created_at = now() - interval '1 hour' where id = ${first.id}`,
    );
    const res = await api(app, 'GET', '/api/admin/invites', { cookie: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(InvitesResponse.parse(res.json()).invites.map((i) => i.id)).toEqual([second.id, first.id]);
  });

  it('DELETE revokes (sets revokedAt), is idempotent, and 404s on unknown ids', async () => {
    const invite = await insertInvite();
    expect(
      (await api(app, 'DELETE', `/api/admin/invites/${invite.id}`, { cookie: adminCookie })).statusCode,
    ).toBe(204);
    const revokedAt = (await getInvite(invite.id)).revokedAt;
    expect(revokedAt).toBeInstanceOf(Date);
    expect(
      (await api(app, 'DELETE', `/api/admin/invites/${invite.id}`, { cookie: adminCookie })).statusCode,
    ).toBe(204);
    expect((await getInvite(invite.id)).revokedAt).toEqual(revokedAt);

    expectError(await registerViaApi(app, 'carol', invite.code), 400, 'INVITE_INVALID');
    expectError(
      await api(app, 'DELETE', '/api/admin/invites/00000000-0000-4000-8000-000000000000', {
        cookie: adminCookie,
      }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await api(app, 'DELETE', '/api/admin/invites/not-a-uuid', { cookie: adminCookie }),
      400,
      'VALIDATION',
    );
  });
});

describe('reset codes', () => {
  async function issue(userId: string): Promise<ResetCodeResponse> {
    const res = await api(app, 'POST', `/api/admin/users/${userId}/reset-code`, { cookie: adminCookie });
    expect(res.statusCode, res.payload).toBe(200);
    return ResetCodeResponse.parse(res.json());
  }

  function reset(username: string, code: string, newPassword = 'reset password 123') {
    return api(app, 'POST', '/api/auth/reset-password', { body: { username, code, newPassword } });
  }

  it('issues a 12-char code valid 24 h, stored only as a hash', async () => {
    const bob = await insertUser('bob');
    const before = Date.now();
    const { code, expiresAt } = await issue(bob.id);
    expect(code).toMatch(CODE_RE(12));
    const hours = (Date.parse(expiresAt) - before) / HOUR_MS;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    const [row] = await testDb().db.select().from(passwordResetCodes);
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.codeHash).not.toContain(code);
  });

  it('404 for an unknown user', async () => {
    expectError(
      await api(app, 'POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/reset-code', {
        cookie: adminCookie,
      }),
      404,
      'NOT_FOUND',
    );
  });

  it('is single-use and revokes every session of the user', async () => {
    const bob = await insertUser('bob');
    const bobA = await login(app, 'bob');
    await login(app, 'bob');
    expect(await sessionCount(bob.id)).toBe(2);

    const { code } = await issue(bob.id);
    expect((await reset('bob', code)).statusCode).toBe(204);
    expect(await sessionCount(bob.id)).toBe(0);
    expectError(await api(app, 'GET', '/api/me', { cookie: bobA }), 401, 'UNAUTHENTICATED');

    // Old password no longer works; new one does.
    expectError(
      await api(app, 'POST', '/api/auth/login', { body: { username: 'bob', password: PASSWORD } }),
      401,
      'INVALID_CREDENTIALS',
    );
    await login(app, 'bob', 'reset password 123');

    // Second use fails.
    expectError(await reset('bob', code, 'another password 456'), 401, 'INVALID_CREDENTIALS');
    await login(app, 'bob', 'reset password 123');
  });

  it('accepts the code in lower case', async () => {
    const bob = await insertUser('bob');
    const { code } = await issue(bob.id);
    expect((await reset('bob', code.toLowerCase())).statusCode).toBe(204);
  });

  it('an expired code gives INVALID_CREDENTIALS', async () => {
    const bob = await insertUser('bob');
    const { code } = await issue(bob.id);
    await testDb()
      .db.update(passwordResetCodes)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(passwordResetCodes.userId, bob.id));
    expectError(await reset('bob', code), 401, 'INVALID_CREDENTIALS');
    await login(app, 'bob');
  });

  it('a code only works for its own user, and a wrong or unknown username fails the same way', async () => {
    const bob = await insertUser('bob');
    await insertUser('carol');
    const { code } = await issue(bob.id);
    const a = expectError(await reset('carol', code), 401, 'INVALID_CREDENTIALS');
    const b = expectError(await reset('nobody', code), 401, 'INVALID_CREDENTIALS');
    const c = expectError(await reset('bob', 'WRONGCODE123'), 401, 'INVALID_CREDENTIALS');
    expect(new Set([a.error.message, b.error.message, c.error.message]).size).toBe(1);
    expect((await reset('bob', code)).statusCode).toBe(204);
  });

  it('issuing a new code invalidates the older unused one', async () => {
    const bob = await insertUser('bob');
    const first = await issue(bob.id);
    const second = await issue(bob.id);
    expectError(await reset('bob', first.code), 401, 'INVALID_CREDENTIALS');
    expect((await reset('bob', second.code)).statusCode).toBe(204);
  });

  it('an invalid new password gives VALIDATION', async () => {
    const bob = await insertUser('bob');
    const { code } = await issue(bob.id);
    expectError(await reset('bob', code, 'short'), 400, 'VALIDATION');
    // The code was not consumed.
    expect((await reset('bob', code)).statusCode).toBe(204);
  });
});
