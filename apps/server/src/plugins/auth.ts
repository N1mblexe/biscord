import { fastifyCookie } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '@hearth/shared';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { resolveSession, type AuthContext } from '../services/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The resolved session, or `null` for anonymous requests (set by the auth hook). */
    auth: AuthContext | null;
  }
}

const DAY_SECONDS = 24 * 60 * 60;

/** Reads the session token from a raw `Cookie` header (REST and the Socket.IO handshake). */
export function sessionTokenFromCookieHeader(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;
  const token = fastifyCookie.parse(header)[SESSION_COOKIE];
  return token === undefined || token === '' ? null : token;
}

export function setSessionCookie(reply: FastifyReply, env: Env, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: env.COOKIE_SECURE,
    maxAge: env.SESSION_TTL_DAYS * DAY_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: Env): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: env.COOKIE_SECURE,
  });
}

/** Narrows `request.auth`; throws UNAUTHENTICATED for anonymous requests (defense in depth after `requireUser`). */
export function authOf(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return request.auth;
}

export interface AuthGuards {
  /** preHandler: 401 UNAUTHENTICATED without a valid session (and clears a stale cookie). */
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** preHandler: 401 for anonymous requests, 403 FORBIDDEN for non-admins. */
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Registers `@fastify/cookie` and an `onRequest` hook that resolves `request.auth` from the session cookie.
 * The hook parses the raw header itself, so it does not depend on plugin load order.
 */
export function registerAuth(app: FastifyInstance, { db, env }: { db: Db; env: Env }): AuthGuards {
  void app.register(fastifyCookie);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    const token = sessionTokenFromCookieHeader(request.headers.cookie);
    const resolved = token === null ? null : await resolveSession(db, token, env.SESSION_TTL_DAYS);
    request.auth = resolved === null ? null : { user: resolved.user, session: resolved.session };
    // Sliding expiry: when the DB expiry moved, re-send the same token with the full Max-Age so the browser's
    // cookie slides too. A later `clearSessionCookie` (logout) on this reply replaces it.
    if (token !== null && resolved?.bumped === true) setSessionCookie(reply, env, token);
  });

  // Promise-returning (not callback-style) so Fastify awaits it; rejection goes to the error handler.
  const requireUser = (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.auth !== null) return Promise.resolve();
    if (sessionTokenFromCookieHeader(request.headers.cookie) !== null) clearSessionCookie(reply, env);
    return Promise.reject(new AppError('UNAUTHENTICATED', 'Authentication required'));
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireUser(request, reply);
    if (request.auth?.user.role !== 'admin') throw new AppError('FORBIDDEN', 'Admins only');
  };

  return { requireUser, requireAdmin };
}
