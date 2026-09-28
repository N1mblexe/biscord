import { describe, expect, it, vi } from 'vitest';
import { fetchHealth, type FetchLike } from './health';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const respondWith =
  (res: Response): FetchLike =>
  () =>
    Promise.resolve(res);

describe('fetchHealth', () => {
  it('returns ok for a healthy server', async () => {
    const fetchImpl = vi.fn<FetchLike>(respondWith(jsonResponse({ status: 'ok', db: 'ok' })));
    await expect(fetchHealth(fetchImpl)).resolves.toBe('ok');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/health');
  });

  it('accepts the optional livekit field', async () => {
    const res = jsonResponse({ status: 'ok', db: 'ok', livekit: 'ok' });
    await expect(fetchHealth(respondWith(res))).resolves.toBe('ok');
  });

  it('returns degraded for a 503 degraded body', async () => {
    const res = jsonResponse({ status: 'degraded', db: 'down' }, 503);
    await expect(fetchHealth(respondWith(res))).resolves.toBe('degraded');
  });

  it('returns unreachable on a network error', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    await expect(fetchHealth(fetchImpl)).resolves.toBe('unreachable');
  });

  it('returns unreachable for a body that fails the schema', async () => {
    const res = jsonResponse({ status: 'fine', db: 'ok' });
    await expect(fetchHealth(respondWith(res))).resolves.toBe('unreachable');
  });

  it('returns unreachable for a non-JSON body (e.g. proxy error page)', async () => {
    const res = new Response('<html>Bad Gateway</html>', { status: 502 });
    await expect(fetchHealth(respondWith(res))).resolves.toBe('unreachable');
  });

  it('rethrows when the request was aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchLike = () => Promise.reject(new DOMException('Aborted', 'AbortError'));
    await expect(fetchHealth(fetchImpl, controller.signal)).rejects.toThrow('Aborted');
  });
});
