import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { shouldRetry } from '../queryClient';
import { connectErrorReason, revokedReason } from './socket';

describe('connectErrorReason', () => {
  it('treats a handshake UNAUTHENTICATED as a dead session', () => {
    expect(connectErrorReason({ data: { code: 'UNAUTHENTICATED' } })).toBe('unauthenticated');
  });

  it('ignores other connect errors (socket.io retries those)', () => {
    expect(connectErrorReason({})).toBeNull();
    expect(connectErrorReason({ data: { code: 'FORBIDDEN' } })).toBeNull();
    expect(connectErrorReason({ data: 'nope' })).toBeNull();
  });
});

describe('revokedReason', () => {
  it('passes the server reason through', () => {
    expect(revokedReason({ reason: 'password_changed' })).toBe('password_changed');
    expect(revokedReason({ reason: 'logout' })).toBe('logout');
  });

  it('falls back to unauthenticated for a malformed payload', () => {
    expect(revokedReason({ reason: 'bogus' })).toBe('unauthenticated');
    expect(revokedReason(undefined)).toBe('unauthenticated');
  });
});

describe('shouldRetry', () => {
  it('does not retry 4xx', () => {
    expect(shouldRetry(0, new ApiError(401, 'UNAUTHENTICATED', 'no'))).toBe(false);
    expect(shouldRetry(0, new ApiError(429, 'RATE_LIMITED', 'slow down'))).toBe(false);
  });

  it('retries network and 5xx errors twice', () => {
    const network = new ApiError(0, 'INTERNAL', 'offline');
    expect(shouldRetry(0, network)).toBe(true);
    expect(shouldRetry(1, new ApiError(503, 'LIVEKIT_UNAVAILABLE', 'down'))).toBe(true);
    expect(shouldRetry(2, network)).toBe(false);
  });
});
