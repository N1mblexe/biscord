import { z } from 'zod';

export const ErrorCode = z.enum([
  'VALIDATION',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'USERNAME_TAKEN',
  'INVITE_INVALID',
  'USER_LIMIT',
  'LAST_ADMIN',
  'CHANNEL_LIMIT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'RATE_LIMITED',
  'LIVEKIT_UNAVAILABLE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status for each error code (B.3). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  INVITE_INVALID: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  USER_LIMIT: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  USERNAME_TAKEN: 409,
  LAST_ADMIN: 409,
  CHANNEL_LIMIT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  LIVEKIT_UNAVAILABLE: 503,
};

/**
 * Error body for REST responses and socket acks.
 * `details`: VALIDATION → `z.flattenError()` output; RATE_LIMITED → `{ retryAfterMs }`.
 */
export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
export type ApiErrorPayload = ApiErrorBody['error'];

/** `details` shape for RATE_LIMITED. */
export const RateLimitedDetails = z.object({ retryAfterMs: z.number().int().nonnegative() });
export type RateLimitedDetails = z.infer<typeof RateLimitedDetails>;

/** Ack for every socket client→server event. */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: ApiErrorPayload };

export function ackOk<T>(data: T): Ack<T> {
  return { ok: true, data };
}

export function ackErr(code: ErrorCode, message: string, details?: unknown): Ack<never> {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}
