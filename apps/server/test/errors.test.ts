import { ApiErrorBody, CSRF_HEADER, CSRF_HEADER_VALUE } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { AppError, loggableError } from '../src/lib/errors.js';
import { parse } from '../src/lib/validate.js';
import { makeApp } from './helpers/app.js';
import { closeTestDb } from './helpers/db.js';

const csrf = { [CSRF_HEADER]: CSRF_HEADER_VALUE };
const json = { 'content-type': 'application/json' };

let app: FastifyInstance;

beforeEach(async () => {
  app = makeApp();
  app.post('/api/__probe', (request) => {
    const body = parse(z.object({ n: z.number() }), request.body);
    return { ok: true, n: body.n };
  });
  app.post('/api/__probe/last-admin', () => {
    throw new AppError('LAST_ADMIN', 'Cannot remove the last admin');
  });
  app.post('/api/__probe/boom', () => {
    throw new Error('boom');
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(closeTestDb);

function errorBody(payload: string): ApiErrorBody {
  return ApiErrorBody.parse(JSON.parse(payload));
}

describe('error format', () => {
  it('unknown route → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    errorBody(res.payload);
  });

  it('POST without the CSRF header → 403 FORBIDDEN', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/__probe', headers: json, payload: '{"n":1}' });
    expect(res.statusCode).toBe(403);
    expect(errorBody(res.payload).error.code).toBe('FORBIDDEN');
  });

  it('POST with a wrong CSRF header value → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { ...json, [CSRF_HEADER]: 'XMLHttpRequest' },
      payload: '{"n":1}',
    });
    expect(res.statusCode).toBe(403);
    expect(errorBody(res.payload).error.code).toBe('FORBIDDEN');
  });

  it('malformed JSON → 400 VALIDATION', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { ...json, ...csrf },
      payload: '{"n":',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res.payload).error.code).toBe('VALIDATION');
  });

  it('schema mismatch → 400 VALIDATION with flattened details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { ...json, ...csrf },
      payload: '{"n":"x"}',
    });
    expect(res.statusCode).toBe(400);
    const body = errorBody(res.payload);
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.details).toMatchObject({ fieldErrors: { n: expect.any(Array) as unknown } });
  });

  it('valid JSON with the CSRF header → 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { ...json, ...csrf },
      payload: '{"n":7}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, n: 7 });
  });

  it('unsupported content type → 415 UNSUPPORTED_MEDIA', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { 'content-type': 'application/x-unknown', ...csrf },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(415);
    expect(errorBody(res.payload).error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it('empty JSON body → 400 VALIDATION', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/__probe', headers: { ...json, ...csrf } });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res.payload).error.code).toBe('VALIDATION');
  });

  it('body over the limit → 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe',
      headers: { ...json, ...csrf },
      payload: JSON.stringify({ n: 1, pad: 'x'.repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(errorBody(res.payload).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('AppError maps to its shared status', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/__probe/last-admin', headers: csrf });
    expect(res.statusCode).toBe(409);
    expect(errorBody(res.payload).error).toEqual({
      code: 'LAST_ADMIN',
      message: 'Cannot remove the last admin',
    });
  });

  it('unexpected errors → 500 INTERNAL without leaking internals', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/__probe/boom', headers: csrf });
    expect(res.statusCode).toBe(500);
    expect(errorBody(res.payload).error.code).toBe('INTERNAL');
    expect(res.payload).not.toContain('boom');
  });

  it('the LiveKit webhook is exempt from the CSRF header', async () => {
    // No X-Requested-With: it reaches the route (401 for the missing signature, not 403 CSRF).
    const res = await app.inject({
      method: 'POST',
      url: '/api/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(errorBody(res.payload).error.code).toBe('UNAUTHENTICATED');
    // Only the raw webhook type is accepted.
    const asJson = await app.inject({
      method: 'POST',
      url: '/api/livekit/webhook',
      headers: json,
      payload: '{}',
    });
    expect(asJson.statusCode).toBe(415);
    expect(errorBody(asJson.payload).error.code).toBe('UNSUPPORTED_MEDIA');
  });
});

describe('loggableError', () => {
  it('drops the bound parameters and the row detail from Drizzle query errors', () => {
    const driverError = Object.assign(
      new Error('new row for relation "messages" violates check constraint'),
      {
        code: '23514',
        constraint: 'messages_content_len_ck',
        detail: 'Failing row contains (1, secret message content)',
      },
    );
    const err = new DrizzleQueryError(
      'insert into "messages" values ($1)',
      ['secret message content'],
      driverError,
    );
    const safe = loggableError(err);
    expect(safe).toBeInstanceOf(Error);
    const serialized = JSON.stringify(safe, [
      'name',
      'message',
      'stack',
      'cause',
      'code',
      'constraint',
      'detail',
    ]);
    expect(serialized).not.toContain('secret message content');
    expect(serialized).toContain('insert into \\"messages\\"');
    expect(serialized).toContain('23514');
    expect(serialized).toContain('messages_content_len_ck');
    expect((safe as Error).stack).not.toContain('secret');
  });

  it('passes other errors through unchanged', () => {
    const err = new Error('boom');
    expect(loggableError(err)).toBe(err);
  });
});
