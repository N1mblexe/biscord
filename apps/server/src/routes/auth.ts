import type { FastifyInstance } from 'fastify';
import {
  InviteCheckResponse,
  InviteCodeParams,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  UserResponse,
} from '@hearth/shared';
import { AppError } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { toMe } from '../lib/serialize.js';
import { parseLenient } from '../lib/validate.js';
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
    const input = parseLenient(RegisterRequest, request.body);
    // B.9 rule 1: an invite code with a NUL is answered like an unknown one.
    if (input === null) throw new AppError('INVITE_INVALID', 'This invite is invalid or has expired');
    const { user, token } = await register(db, config, input, request.headers['user-agent']);
    setSessionCookie(reply, env, token);
    return send(reply, UserResponse, { user: toMe(user) }, 201);
  });

  app.post('/api/auth/login', { config: rateLimiter.authRoute }, async (request, reply) => {
    const input = parseLenient(LoginRequest, request.body);
    if (input === null) throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password');
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
    const input = parseLenient(ResetPasswordRequest, request.body);
    if (input === null) throw new AppError('INVALID_CREDENTIALS', 'Invalid username or reset code');
    const revoked = await resetPassword(db, input);
    realtime.revokeSessions(revoked, 'password_reset');
    return reply.status(204).send();
  });

  app.get('/api/invites/:code/check', { config: rateLimiter.authRoute }, async (request, reply) => {
    const params = parseLenient(InviteCodeParams, request.params);
    const valid = params !== null && (await isInviteRedeemable(db, params.code));
    return send(reply, InviteCheckResponse, { valid });
  });
}
