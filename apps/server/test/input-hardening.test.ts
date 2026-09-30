import { InviteCheckResponse, MessageResponse, UserResponse } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invites, passwordResetCodes, users } from '../src/db/schema.js';
import type { ChannelRow, UserRow } from '../src/db/types.js';
import { sha256Hex } from '../src/lib/crypto.js';
import { makeApp } from './helpers/app.js';
import {
  api,
  expectError,
  insertInvite,
  insertUser,
  login,
  PASSWORD,
  registerViaApi,
} from './helpers/auth.js';
import { insertChannel, insertMessage } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';

const NUL = '\u0000';

let app: FastifyInstance;
let admin: UserRow;
let bob: UserRow;
let adminCookie: string;
let bobCookie: string;
let general: ChannelRow;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  admin = await insertUser('admin', { role: 'admin' });
  bob = await insertUser('bob');
  adminCookie = await login(app, 'admin');
  bobCookie = await login(app, 'bob');
  general = await insertChannel('general');
});
afterEach(async () => {
  await app.close();
});
afterAll(closeTestDb);

async function displayNameOf(id: string): Promise<string | undefined> {
  const [row] = await testDb()
    .db.select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, id));
  return row?.displayName;
}

describe('CSRF is decided from the matched route (B.9 rule 2)', () => {
  const encoded = ['/%61pi/me', '/api/%6De', '/%61%70%69/%6d%65', '/api/m%65'];

  it.each(encoded)('PATCH %s without the header → 403, nothing changes', async (url) => {
    const res = await api(app, 'PATCH', url, {
      cookie: bobCookie,
      body: { displayName: 'pwned' },
      noCsrf: true,
    });
    expectError(res, 403, 'FORBIDDEN');
    expect(await displayNameOf(bob.id)).toBe('bob');
  });

  it('the same encoded path with the header reaches the route (it really is /api/me)', async () => {
    const res = await api(app, 'PATCH', '/%61pi/me', { cookie: bobCookie, body: { displayName: 'Bobby' } });
    expect(res.statusCode, res.payload).toBe(200);
    expect(UserResponse.parse(res.json()).user.displayName).toBe('Bobby');
  });

  it('an encoded path to another state-changing route is refused too', async () => {
    const res = await api(app, 'POST', '/%61pi/me/password', {
      cookie: bobCookie,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
      noCsrf: true,
    });
    expectError(res, 403, 'FORBIDDEN');
    await login(app, 'bob');
  });

  it('non-/api and unmatched paths are not exempt; safe methods need no header', async () => {
    expectError(await api(app, 'POST', '/not-api', { body: {}, noCsrf: true }), 403, 'FORBIDDEN');
    expectError(await api(app, 'DELETE', '/api/nothing-here', { noCsrf: true }), 403, 'FORBIDDEN');
    expect((await api(app, 'GET', '/%61pi/me', { cookie: bobCookie, noCsrf: true })).statusCode).toBe(200);
  });

  it('the webhook route stays exempt, also when reached through an encoded path', async () => {
    for (const url of ['/api/livekit/webhook', '/api/livekit/%77ebhook']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/webhook+json' },
        payload: '{}',
      });
      // Reaches the route: 401 for the missing signature, not 403.
      expectError(res, 401, 'UNAUTHENTICATED');
    }
  });
});

describe('NUL characters never reach Postgres (B.9 rule 1)', () => {
  it('login: a NUL in the username or password → INVALID_CREDENTIALS', async () => {
    for (const body of [
      { username: `bob${NUL}`, password: PASSWORD },
      { username: 'bob', password: `${PASSWORD}${NUL}` },
      { username: NUL, password: NUL },
    ]) {
      expectError(await api(app, 'POST', '/api/auth/login', { body }), 401, 'INVALID_CREDENTIALS');
    }
    // Other malformed input keeps its answer.
    expectError(await api(app, 'POST', '/api/auth/login', { body: { username: '' } }), 400, 'VALIDATION');
  });

  it('PATCH /me: a NUL in the display name → VALIDATION', async () => {
    const res = await api(app, 'PATCH', '/api/me', { cookie: bobCookie, body: { displayName: `Bo${NUL}b` } });
    expectError(res, 400, 'VALIDATION');
    expect(await displayNameOf(bob.id)).toBe('bob');
  });

  it('register: a NUL in the invite code → INVITE_INVALID; in another field → VALIDATION', async () => {
    const invite = await insertInvite();
    const withNulCode = await api(app, 'POST', '/api/auth/register', {
      body: { inviteCode: `${invite.code}${NUL}`, username: 'dave', displayName: 'Dave', password: PASSWORD },
    });
    expectError(withNulCode, 400, 'INVITE_INVALID');
    for (const body of [
      { inviteCode: invite.code, username: 'dave', displayName: `Da${NUL}ve`, password: PASSWORD },
      { inviteCode: invite.code, username: `dave${NUL}`, displayName: 'Dave', password: PASSWORD },
      { inviteCode: invite.code, username: 'dave', displayName: 'Dave', password: `${PASSWORD}${NUL}` },
    ]) {
      expectError(await api(app, 'POST', '/api/auth/register', { body }), 400, 'VALIDATION');
    }
    // The invite is untouched and still works.
    expect((await registerViaApi(app, 'dave', invite.code)).statusCode).toBe(201);
  });

  it('reset-password: a NUL in the username or code → INVALID_CREDENTIALS; in the new password → VALIDATION', async () => {
    const newPassword = 'reset password 123';
    for (const body of [
      { username: `bob${NUL}`, code: 'ABCDEFGH1234', newPassword },
      { username: 'bob', code: `ABCD${NUL}`, newPassword },
    ]) {
      expectError(await api(app, 'POST', '/api/auth/reset-password', { body }), 401, 'INVALID_CREDENTIALS');
    }
    expectError(
      await api(app, 'POST', '/api/auth/reset-password', {
        body: { username: 'bob', code: 'ABCDEFGH1234', newPassword: `${newPassword}${NUL}` },
      }),
      400,
      'VALIDATION',
    );
  });

  it('change-password: a NUL in the current password → INVALID_CREDENTIALS; in the new one → VALIDATION', async () => {
    expectError(
      await api(app, 'POST', '/api/me/password', {
        cookie: bobCookie,
        body: { currentPassword: `x${NUL}`, newPassword: 'a brand new password' },
      }),
      401,
      'INVALID_CREDENTIALS',
    );
    expectError(
      await api(app, 'POST', '/api/me/password', {
        cookie: bobCookie,
        body: { currentPassword: PASSWORD, newPassword: `a brand new password${NUL}` },
      }),
      400,
      'VALIDATION',
    );
    await login(app, 'bob');
  });

  it('invite check: a NUL in the code → {valid:false}', async () => {
    const invite = await insertInvite();
    for (const code of ['%00', `${invite.code}%00`, `%00${invite.code}`]) {
      const res = await api(app, 'GET', `/api/invites/${code}/check`);
      expect(res.statusCode, res.payload).toBe(200);
      expect(InviteCheckResponse.parse(res.json())).toEqual({ valid: false });
    }
  });

  it('message send and edit: a NUL in the content or nonce → VALIDATION', async () => {
    const url = `/api/channels/${general.id}/messages`;
    for (const body of [{ content: `hi${NUL}` }, { content: 'hi', nonce: `n${NUL}` }]) {
      expectError(await api(app, 'POST', url, { cookie: bobCookie, body }), 400, 'VALIDATION');
    }
    const message = await insertMessage(general.id, bob.id, 'original');
    expectError(
      await api(app, 'PATCH', `/api/messages/${message.id}`, {
        cookie: bobCookie,
        body: { content: `x${NUL}` },
      }),
      400,
      'VALIDATION',
    );
    const ok = await api(app, 'POST', url, { cookie: bobCookie, body: { content: 'fine', nonce: 'n1' } });
    expect(MessageResponse.parse(ok.json()).message.content).toBe('fine');
  });

  it('channel create and rename: a NUL in the name → VALIDATION', async () => {
    expectError(
      await api(app, 'POST', '/api/channels', {
        cookie: adminCookie,
        body: { type: 'text', name: `a${NUL}` },
      }),
      400,
      'VALIDATION',
    );
    expectError(
      await api(app, 'PATCH', `/api/channels/${general.id}`, {
        cookie: adminCookie,
        body: { name: `a${NUL}` },
      }),
      400,
      'VALIDATION',
    );
  });
});

describe('codes are matched with Crockford normalization (B.9 rule 5)', () => {
  it('invite codes: O → 0 and I/L → 1, any case', async () => {
    const invite = await insertInvite();
    await testDb().db.update(invites).set({ code: 'AB0123456789WXYZ' }).where(eq(invites.id, invite.id));
    const wrong = await api(app, 'GET', '/api/invites/abO1I3456789wxyz/check'); // '0113…': a different code
    expect(InviteCheckResponse.parse(wrong.json()).valid).toBe(false);
    for (const code of ['abO123456789wxyz', 'AB0I23456789WXYZ', 'aboL23456789wxyz']) {
      const res = await api(app, 'GET', `/api/invites/${code}/check`);
      expect(InviteCheckResponse.parse(res.json()).valid, code).toBe(true);
    }
    expect((await registerViaApi(app, 'dave', 'ABOL23456789WXYZ')).statusCode).toBe(201);
  });

  it('reset codes: O → 0 and I/L → 1, any case', async () => {
    await testDb()
      .db.insert(passwordResetCodes)
      .values({
        userId: bob.id,
        codeHash: sha256Hex('011123456789'),
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const res = await api(app, 'POST', '/api/auth/reset-password', {
      body: { username: 'bob', code: 'oLiI23456789', newPassword: 'reset password 123' },
    });
    expect(res.statusCode, res.payload).toBe(204);
    await login(app, 'bob', 'reset password 123');
  });
});
