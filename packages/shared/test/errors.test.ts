import { describe, expect, it } from 'vitest';
import { ApiErrorBody, ERROR_STATUS, ErrorCode, ackErr, ackOk } from '../src/index.js';

const EXPECTED: Record<ErrorCode, number> = {
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
  UPLOAD_QUOTA: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  LIVEKIT_UNAVAILABLE: 503,
  STORAGE_FULL: 507,
};

describe('errors', () => {
  it('has exactly the 18 B.3 codes', () => {
    expect(ErrorCode.options).toHaveLength(18);
    expect([...ErrorCode.options].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('maps every code to its B.3 HTTP status', () => {
    for (const code of ErrorCode.options) {
      expect(ERROR_STATUS[code], code).toBe(EXPECTED[code]);
    }
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCode.options].sort());
  });

  it('builds acks', () => {
    expect(ackOk(null)).toEqual({ ok: true, data: null });
    expect(ackErr('FORBIDDEN', 'nope')).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    const err = ackErr('RATE_LIMITED', 'slow down', { retryAfterMs: 1000 });
    expect(err).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'slow down', details: { retryAfterMs: 1000 } },
    });
    if (!err.ok) expect(ApiErrorBody.safeParse({ error: err.error }).success).toBe(true);
  });

  it('rejects unknown codes in ApiErrorBody', () => {
    expect(ApiErrorBody.safeParse({ error: { code: 'TEAPOT', message: 'x' } }).success).toBe(false);
  });
});
