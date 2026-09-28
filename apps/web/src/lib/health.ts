import { HealthResponse } from '@hearth/shared';

export type ServerHealth = 'ok' | 'degraded' | 'unreachable';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Calls `GET /api/health` and reduces the answer to one of three states.
 * The server answers 503 with a valid `{status:'degraded'}` body when the DB is down,
 * so the body is parsed regardless of the HTTP status.
 * Network errors and bodies that don't match `HealthResponse` count as unreachable.
 * An abort (component unmounted) rethrows the AbortError so callers can ignore it.
 */
export async function fetchHealth(fetchImpl: FetchLike, signal?: AbortSignal): Promise<ServerHealth> {
  let body: unknown;
  try {
    const res = await fetchImpl('/api/health', { signal, headers: { Accept: 'application/json' } });
    body = await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    return 'unreachable';
  }
  const parsed = HealthResponse.safeParse(body);
  if (!parsed.success) return 'unreachable';
  return parsed.data.status;
}
