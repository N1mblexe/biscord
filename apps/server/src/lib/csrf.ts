import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@hearth/shared';
import { AppError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = new Set(['/api/livekit/webhook']);

/** Requires `X-Requested-With: hearth` on every state-changing `/api/*` request (CONTRACTS B.4). */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const path = request.url.split('?', 1)[0] ?? '';
    const exempt = SAFE_METHODS.has(request.method) || !path.startsWith('/api/') || EXEMPT_PATHS.has(path);
    if (!exempt && request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      done(new AppError('FORBIDDEN', 'Missing or invalid CSRF header'));
      return;
    }
    done();
  });
}
