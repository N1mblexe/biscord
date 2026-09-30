import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@hearth/shared';
import { WEBHOOK_PATH } from '../routes/livekit-webhook.js';
import { AppError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Requires `X-Requested-With: hearth` on every request except GET/HEAD/OPTIONS and the LiveKit webhook
 * (CONTRACTS B.4, B.9 rule 2). The exemption is decided from the route the router matched
 * (`routeOptions.url`, the registered pattern), never from the raw URL: `/%61pi/me` is routed to `/api/me`,
 * so any check on the raw string could be sidestepped by percent-encoding. Unmatched requests (404) are not
 * exempt either.
 */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const exempt =
      SAFE_METHODS.has(request.method) ||
      // The webhook is authenticated by the LiveKit signature instead.
      (request.method === 'POST' && request.routeOptions.url === WEBHOOK_PATH);
    if (!exempt && request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      done(new AppError('FORBIDDEN', 'Missing or invalid CSRF header'));
      return;
    }
    done();
  });
}
