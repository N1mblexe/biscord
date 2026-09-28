import type { SessionRevokedReason } from '@hearth/shared';

/**
 * Values of `/login?reason=`: every `session:revoked` reason, plus `unauthenticated` for a
 * socket handshake or API call rejected because the session is gone.
 */
export type LoginReason = SessionRevokedReason | 'unauthenticated';

const NOTICES: Record<LoginReason, string> = {
  logout: 'You have been logged out.',
  deactivated: 'Your account has been deactivated.',
  password_changed: 'Your password was changed. Please log in again.',
  password_reset: 'Your password was reset. Please log in with your new password.',
  unauthenticated: 'Your session has ended. Please log in again.',
};

const GENERIC_NOTICE = 'Please log in again.';

function isLoginReason(value: string): value is LoginReason {
  return Object.hasOwn(NOTICES, value);
}

/** Human text for `?reason=`; `null` when there is no reason. Unknown reasons get a generic notice. */
export function authNoticeText(reason: string | null): string | null {
  if (!reason) return null;
  return isLoginReason(reason) ? NOTICES[reason] : GENERIC_NOTICE;
}

export function loginPathForReason(reason: LoginReason): string {
  return `/login?reason=${encodeURIComponent(reason)}`;
}
