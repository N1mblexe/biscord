import type { FastifyInstance } from 'fastify';
import {
  InviteCheckResponse,
  InviteCodeParams,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  UserResponse,
} from '@hearth/shared';
import { send } from '../lib/respond.js';
import { toMe } from '../lib/serialize.js';
import { parse } from '../lib/validate.js';
import { authOf, clearSessionCookie, setSessionCookie } from '../plugins/auth.js';
import { login, register, resetPassword, type AuthConfig } from '../services/auth.js';
import { isInviteRedeemable } from '../services/invites.js';
import { deleteSession } from '../services/sessions.js';
import type { RouteDeps } from './deps.js';

/** CONTRACTS B.4 rows 2–6. */
export function registerAuthRoutes(
  app: FastifyInstance,
  { db, env, guards, rateLimiter, realtime }: RouteDeps,
): void {
  const config: AuthConfig = { maxUsers: env.MAX_USERS, sessionTtlDays: env.SESSION_TTL_DAYS };

  app.post('/api/auth/register', { config: rateLimiter.authRoute }, async (request, reply) => {
    const input = parse(RegisterRequest, request.body);
    const { user, token } = await register(db, config, input, request.headers['user-agent']);
    setSessionCookie(reply, env, token);
    return send(reply, UserResponse, { user: toMe(user) }, 201);
  });

  app.post('/api/auth/login', { config: rateLimiter.authRoute }, async (request, reply) => {
    const input = parse(LoginRequest, request.body);
    const { user, token } = await login(db, config, input, request.headers['user-agent']);
    setSessionCookie(reply, env, token);
    return send(reply, UserResponse, { user: toMe(user) });
  });

  app.post('/api/auth/logout', { preHandler: guards.requireUser }, async (request, reply) => {
    const { session } = authOf(request);
    const revoked = await deleteSession(db, session.id);
    realtime.revokeSessions(revoked, 'logout');
    clearSessionCookie(reply, env);
    return reply.status(204).send();
  });

  app.post('/api/auth/reset-password', { config: rateLimiter.authRoute }, async (request, reply) => {
    const input = parse(ResetPasswordRequest, request.body);
    const revoked = await resetPassword(db, input);
    realtime.revokeSessions(revoked, 'password_reset');
    return reply.status(204).send();
  });

  app.get('/api/invites/:code/check', { config: rateLimiter.authRoute }, async (request, reply) => {
    const { code } = parse(InviteCodeParams, request.params);
    return send(reply, InviteCheckResponse, { valid: await isInviteRedeemable(db, code) });
  });
}
