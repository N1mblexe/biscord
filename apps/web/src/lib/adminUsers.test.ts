import type { PublicUser } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import {
  ADMIN_USER_ACTION_LABELS,
  adminUserError,
  reduceUsers,
  sortUsers,
  userActions,
  userStatus,
  voiceDisconnectError,
} from './adminUsers';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const user = (id: string, username: string, extra: Partial<PublicUser> = {}): PublicUser => ({
  id,
  username,
  displayName: username.toUpperCase(),
  avatarUrl: null,
  role: 'member',
  deactivated: false,
  ...extra,
});

describe('admin users: row actions', () => {
  it('offers the role toggle, a reset code and Deactivate for active users', () => {
    const labels = (u: PublicUser) => userActions(u).map((a) => ADMIN_USER_ACTION_LABELS[a]);
    expect(labels(user(A, 'alice', { role: 'admin' }))).toEqual([
      'Remove admin',
      'Generate reset code',
      'Deactivate',
    ]);
    expect(labels(user(B, 'bob'))).toEqual(['Make admin', 'Generate reset code', 'Deactivate']);
  });

  it('offers only Reactivate for a deactivated user', () => {
    expect(userActions(user(B, 'bob', { deactivated: true }))).toEqual(['reactivate']);
    expect(userActions(user(A, 'alice', { role: 'admin', deactivated: true }))).toEqual(['reactivate']);
  });

  it('maps the status for `user-status`', () => {
    expect(userStatus({ deactivated: false })).toBe('active');
    expect(userStatus({ deactivated: true })).toBe('deactivated');
  });

  it('sorts by username without mutating the input', () => {
    const input = [user(C, 'carol'), user(A, 'alice'), user(B, 'bob')];
    expect(sortUsers(input).map((u) => u.username)).toEqual(['alice', 'bob', 'carol']);
    expect(input.map((u) => u.username)).toEqual(['carol', 'alice', 'bob']);
  });
});

describe('admin users: error mapping', () => {
  it('uses the contract texts for LAST_ADMIN and USER_LIMIT', () => {
    expect(adminUserError(new ApiError(409, 'LAST_ADMIN', 'server text'))).toBe(
      "You can't remove the last admin.",
    );
    expect(adminUserError(new ApiError(403, 'USER_LIMIT', 'server text'))).toBe(
      'The account limit has been reached.',
    );
  });

  it("falls back to the server's message, or a generic one", () => {
    expect(adminUserError(new ApiError(404, 'NOT_FOUND', 'User not found.'))).toBe('User not found.');
    expect(adminUserError(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});

describe('admin voice disconnect: error text (row 31)', () => {
  it('a 503 says the user may already be disconnected (the kick notice may have gone out)', () => {
    expect(voiceDisconnectError(new ApiError(503, 'LIVEKIT_UNAVAILABLE', 'Voice server unavailable'))).toBe(
      "LiveKit didn't confirm the disconnect; they may already be disconnected.",
    );
  });

  it("other errors keep the server's message, or a generic one", () => {
    expect(
      voiceDisconnectError(new ApiError(404, 'NOT_FOUND', 'That user is not in this voice channel')),
    ).toBe('That user is not in this voice channel');
    expect(voiceDisconnectError(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))).toBe(
      'Too many requests',
    );
    expect(voiceDisconnectError(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});

describe('admin users: cache reducer', () => {
  const list = [user(A, 'alice', { role: 'admin' }), user(B, 'bob')];

  it('replaces a user with the server copy (role change)', () => {
    const next = reduceUsers(list, { type: 'user', user: user(B, 'bob', { role: 'admin' }) });
    expect(next?.find((u) => u.id === B)?.role).toBe('admin');
    expect(next?.find((u) => u.id === A)).toBe(list[0]);
    expect(list[1]?.role).toBe('member');
  });

  it('appends a user it did not know', () => {
    expect(reduceUsers(list, { type: 'user', user: user(C, 'carol') })?.map((u) => u.id)).toEqual([A, B, C]);
  });

  it('flips the deactivated flag, idempotently', () => {
    const off = reduceUsers(list, { type: 'deactivated', userId: B, deactivated: true });
    expect(off?.find((u) => u.id === B)?.deactivated).toBe(true);
    expect(reduceUsers(off, { type: 'deactivated', userId: B, deactivated: true })).toEqual(off);
    const on = reduceUsers(off, { type: 'deactivated', userId: B, deactivated: false });
    expect(on).toEqual(list);
    // Unknown user: nothing changes.
    expect(reduceUsers(list, { type: 'deactivated', userId: C, deactivated: true })).toEqual(list);
  });

  it('leaves an empty cache alone', () => {
    expect(reduceUsers(undefined, { type: 'deactivated', userId: B, deactivated: true })).toBeUndefined();
  });
});
