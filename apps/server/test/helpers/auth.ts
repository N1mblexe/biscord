import { ApiErrorBody, CSRF_HEADER, CSRF_HEADER_VALUE, SESSION_COOKIE, type ErrorCode } from '@hearth/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { invites, sessions, users } from '../../src/db/schema.js';
import type { InviteRow, UserRow } from '../../src/db/types.js';
import { hashPassword } from '../../src/services/passwords.js';
import { createInvite } from '../../src/services/invites.js';
import { testDb } from './db.js';

export const csrf = { [CSRF_HEADER]: CSRF_HEADER_VALUE };
export const PASSWORD = 'correct horse battery';

export interface ApiOptions {
  cookie?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  /** Omit the CSRF header (to test that it is enforced). */
  noCsrf?: boolean;
}

/** `app.inject` with the CSRF header, an optional session cookie and a JSON body. */
export function api(
  app: FastifyInstance,
  method: NonNullable<InjectOptions['method']>,
  url: string,
  options: ApiOptions = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(options.noCsrf === true ? {} : csrf), ...options.headers };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
}

/** `hearth_session=<token>` from a response's Set-Cookie, for use as a request `cookie` header. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined || cookie.value === '') throw new Error(`no ${SESSION_COOKIE} cookie in response`);
  return `${SESSION_COOKIE}=${cookie.value}`;
}

/** Asserts the status and the shared error body; returns the body. */
export function expectError(res: LightMyRequestResponse, status: number, code: ErrorCode): ApiErrorBody {
  expect(res.statusCode, res.payload).toBe(status);
  const body = ApiErrorBody.parse(res.json());
  expect(body.error.code).toBe(code);
  return body;
}

export async function insertUser(
  username: string,
  options: { role?: 'admin' | 'member'; password?: string; deactivated?: boolean } = {},
): Promise<UserRow> {
  const [row] = await testDb()
    .db.insert(users)
    .values({
      username,
      displayName: username,
      passwordHash: await hashPassword(options.password ?? PASSWORD),
      role: options.role ?? 'member',
      deactivatedAt: options.deactivated === true ? new Date() : null,
    })
    .returning();
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}

export function insertInvite(
  options: { maxUses?: number; expiresInHours?: number; grantsRole?: 'admin' | 'member' } = {},
): Promise<InviteRow> {
  return createInvite(testDb().db, {
    createdBy: null,
    maxUses: options.maxUses ?? 1,
    expiresInHours: options.expiresInHours ?? 24,
    grantsRole: options.grantsRole ?? 'member',
  });
}

export async function getInvite(id: string): Promise<InviteRow> {
  const [row] = await testDb().db.select().from(invites).where(eq(invites.id, id));
  if (row === undefined) throw new Error('invite not found');
  return row;
}

export async function sessionCount(userId: string): Promise<number> {
  const rows = await testDb()
    .db.select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.length;
}

/** Logs in through the API and returns the session cookie. */
export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<string> {
  const res = await api(app, 'POST', '/api/auth/login', { body: { username, password } });
  expect(res.statusCode, res.payload).toBe(200);
  return sessionCookie(res);
}

/** Registers through the API with a fresh invite and returns the response. */
export async function registerViaApi(
  app: FastifyInstance,
  username: string,
  inviteCode: string,
  password = PASSWORD,
): Promise<LightMyRequestResponse> {
  return api(app, 'POST', '/api/auth/register', {
    body: { inviteCode, username, displayName: username.toUpperCase(), password },
  });
}
