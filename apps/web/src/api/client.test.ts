import { CSRF_HEADER, CSRF_HEADER_VALUE, UserResponse } from '@hearth/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';
import { errorMessage, fieldErrors } from './errors';

const me = {
  id: '6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  role: 'admin',
  deactivated: false,
  createdAt: '2026-09-28T10:00:00.000Z',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

async function catchApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('parses a successful body with the schema and sends cookie + CSRF headers', async () => {
    const fetchFn = mockFetch(() => Promise.resolve(jsonResponse({ user: me })));
    const res = await apiFetch('/me', { schema: UserResponse });
    expect(res.user.username).toBe('alice');

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/me');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect(headersOf(init)[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(headersOf(init)['Content-Type']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('serializes a JSON body with a Content-Type', async () => {
    const fetchFn = mockFetch(() => Promise.resolve(jsonResponse({ user: me })));
    await apiFetch('/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'pw' },
      schema: UserResponse,
    });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
    expect(headersOf(init)[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(init?.body).toBe(JSON.stringify({ username: 'alice', password: 'pw' }));
  });

  it('resolves a 204 to undefined', async () => {
    mockFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws ApiError from the error body', async () => {
    const details = { formErrors: [], fieldErrors: { username: ['Invalid string'] } };
    mockFetch(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 'VALIDATION', message: 'Invalid request', details } }, 400),
      ),
    );
    const err = await catchApiError(apiFetch('/auth/register', { method: 'POST', body: {} }));
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('Invalid request');
    expect(err.details).toEqual(details);
    expect(fieldErrors(err)).toEqual({ username: ['Invalid string'] });
  });

  it('maps INVITE_INVALID and INVALID_CREDENTIALS to fixed messages', async () => {
    mockFetch(() =>
      Promise.resolve(jsonResponse({ error: { code: 'INVITE_INVALID', message: 'Invite invalid' } }, 400)),
    );
    const invite = await catchApiError(apiFetch('/auth/register', { method: 'POST', body: {} }));
    expect(errorMessage(invite)).toBe('This invite is invalid, expired, or already used.');

    mockFetch(() =>
      Promise.resolve(jsonResponse({ error: { code: 'INVALID_CREDENTIALS', message: 'Nope' } }, 401)),
    );
    const creds = await catchApiError(apiFetch('/auth/login', { method: 'POST', body: {} }));
    expect(creds.status).toBe(401);
    expect(errorMessage(creds)).toBe('Wrong username or password.');
    expect(errorMessage(creds, { INVALID_CREDENTIALS: 'Other.' })).toBe('Other.');
  });

  it('throws INTERNAL for a non-JSON error body (e.g. a proxy error page)', async () => {
    mockFetch(() => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })));
    const err = await catchApiError(apiFetch('/me', { schema: UserResponse }));
    expect(err.status).toBe(502);
    expect(err.code).toBe('INTERNAL');
  });

  it('throws INTERNAL with status 0 on a network error', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    const err = await catchApiError(apiFetch('/me', { schema: UserResponse }));
    expect(err.status).toBe(0);
    expect(err.code).toBe('INTERNAL');
  });

  it('throws INTERNAL when a 2xx body fails the schema', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ user: { id: 'nope' } })));
    const err = await catchApiError(apiFetch('/me', { schema: UserResponse }));
    expect(err.status).toBe(200);
    expect(err.code).toBe('INTERNAL');
  });

  it('rethrows an abort instead of wrapping it', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch(() => Promise.reject(new DOMException('Aborted', 'AbortError')));
    await expect(apiFetch('/me', { schema: UserResponse, signal: controller.signal })).rejects.toThrow(
      'Aborted',
    );
  });
});
