import { ApiErrorBody, CSRF_HEADER, CSRF_HEADER_VALUE, type ErrorCode } from '@hearth/shared';
import { t } from '../i18n';

/** Every REST path in CONTRACTS B.4 is relative to this prefix. */
export const API_PREFIX = '/api';

/**
 * The part of a zod schema the client needs. Structural, so the web app doesn't depend on zod
 * directly; any shared schema from `@hearth/shared` fits.
 */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiFetchOptions {
  method?: HttpMethod;
  /** Serialized as JSON. Omit for requests without a body (no Content-Type is sent then). */
  body?: unknown;
  signal?: AbortSignal;
}

/** Every failed request, including network errors (`status` 0) and malformed bodies (`INTERNAL`). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The `ApiError` for a non-2xx response whose body parsed as `json` (`undefined` when it wasn't JSON).
 * A 413 without an `ApiErrorBody` (the reverse proxy's own limit, CONTRACTS B.7a rule 7) is
 * `PAYLOAD_TOO_LARGE`; any other body that isn't an `ApiErrorBody` is `INTERNAL`.
 */
export function errorFromResponse(status: number, json: unknown): ApiError {
  const parsed = json === undefined ? undefined : ApiErrorBody.safeParse(json);
  if (parsed?.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(status, code, message, details);
  }
  if (status === 413) return new ApiError(status, 'PAYLOAD_TOO_LARGE', t('errors.code.PAYLOAD_TOO_LARGE'));
  return new ApiError(status, 'INTERNAL', t('errors.unexpectedStatus', { status }));
}

/** The error for a request that never reached the server (status 0), in the UI language. */
export function networkError(): ApiError {
  return new ApiError(0, 'INTERNAL', t('errors.network'));
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError');
}

async function readJson(res: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * Calls `/api<path>` with the session cookie and the CSRF header.
 * With a `schema`, the 2xx body is validated and returned; without one, the body is ignored
 * and the call resolves to `undefined` (for 204 endpoints).
 * Non-2xx responses throw `ApiError` built from the shared `ApiErrorBody`.
 */
export function apiFetch<T>(
  path: string,
  options: ApiFetchOptions & { schema: ResponseSchema<T> },
): Promise<T>;
export function apiFetch(path: string, options?: ApiFetchOptions): Promise<undefined>;
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions & { schema?: ResponseSchema<T> } = {},
): Promise<T | undefined> {
  const { method = 'GET', body, schema, signal } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    throw networkError();
  }

  if (!res.ok) {
    const json = await readJson(res);
    throw errorFromResponse(res.status, json.ok ? json.value : undefined);
  }

  if (!schema) return undefined;

  const json = res.status === 204 ? undefined : await readJson(res);
  const parsed = json?.ok ? schema.safeParse(json.value) : undefined;
  if (!parsed?.success) {
    throw new ApiError(res.status, 'INTERNAL', t('errors.unexpectedResponse'));
  }
  return parsed.data;
}
