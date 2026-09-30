import type { SessionRevokedReason } from '@hearth/shared';
import { safeNext } from './redirects';

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

/**
 * `/login?reason=<reason>`, plus `&next=<from>` when `from` (pathname + search of the page being
 * left) is a page worth coming back to after logging in again.
 */
export function loginPathForReason(reason: LoginReason, from?: string): string {
  const path = `/login?reason=${encodeURIComponent(reason)}`;
  const next = from === undefined ? '/' : safeNext(from);
  return next === '/' ? path : `${path}&next=${encodeURIComponent(next)}`;
}

/**
 * The way out of the signed-in app, shared by everything that can end the session (a manual
 * logout, `session:revoked`, a refused socket handshake, a 401 from a background refetch). Only the
 * first exit counts: once the app is on its way to `/login`, the 401s that clearing the session
 * provokes must not replace the specific reason with `unauthenticated`.
 */
export class SessionExit {
  #leaving = false;

  get leaving(): boolean {
    return this.#leaving;
  }

  /** Starts leaving; `false` when already on the way out (the caller must then do nothing). */
  begin(): boolean {
    if (this.#leaving) return false;
    this.#leaving = true;
    return true;
  }
}
