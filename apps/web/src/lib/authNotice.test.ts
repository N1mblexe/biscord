import { SessionRevokedReason } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import { authNoticeText, loginPathForReason } from './authNotice';

describe('authNoticeText', () => {
  it('has human text for every session:revoked reason', () => {
    for (const reason of SessionRevokedReason.options) {
      const text = authNoticeText(reason);
      expect(text).toBeTruthy();
      expect(text).not.toContain('_');
    }
  });

  it('maps each reason to its notice', () => {
    expect(authNoticeText('logout')).toBe('You have been logged out.');
    expect(authNoticeText('deactivated')).toBe('Your account has been deactivated.');
    expect(authNoticeText('password_changed')).toBe('Your password was changed. Please log in again.');
    expect(authNoticeText('password_reset')).toBe(
      'Your password was reset. Please log in with your new password.',
    );
    expect(authNoticeText('unauthenticated')).toBe('Your session has ended. Please log in again.');
  });

  it('shows nothing without a reason and a generic notice for unknown ones', () => {
    expect(authNoticeText(null)).toBeNull();
    expect(authNoticeText('')).toBeNull();
    expect(authNoticeText('toString')).toBe('Please log in again.');
    expect(authNoticeText('whatever')).toBe('Please log in again.');
  });
});

describe('loginPathForReason', () => {
  it('builds the /login?reason= URL', () => {
    expect(loginPathForReason('password_changed')).toBe('/login?reason=password_changed');
    expect(loginPathForReason('unauthenticated')).toBe('/login?reason=unauthenticated');
  });
});
