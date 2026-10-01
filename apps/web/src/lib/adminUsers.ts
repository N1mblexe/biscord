import type { ErrorCode, PublicUser } from '@hearth/shared';
import { errorMessage } from '../api/errors';
import { compare } from '../i18n/format';
import { t } from '../i18n/translate';
import type { MessageKey, TFunction } from '../i18n/types';

/**
 * `/admin/users` (docs/plans/phase-8.md, "Web UI contract"): which actions a row offers, their
 * labels, the error texts, and how the cached user list changes after an action.
 */

/** Fixed alert texts for the admin user actions (rows 35–37), as keys (translated when shown). */
const ADMIN_USER_ERRORS = {
  LAST_ADMIN: 'admin.users.errors.lastAdmin',
  USER_LIMIT: 'admin.users.errors.userLimit',
} as const satisfies Partial<Record<ErrorCode, MessageKey>>;

/**
 * Row 31 (admin voice disconnect). A 503 may come after the server already sent the `voice:kicked` notice
 * (only LiveKit's `removeParticipant` failed), so the text must not claim that nothing happened.
 */
const VOICE_DISCONNECT_ERRORS = {
  LIVEKIT_UNAVAILABLE: 'admin.users.errors.voiceDisconnect',
} as const satisfies Partial<Record<ErrorCode, MessageKey>>;

/** `errorMessage` overrides from a code → key table, in the current language. */
function translated(keys: Partial<Record<ErrorCode, MessageKey>>): Partial<Record<ErrorCode, string>> {
  const out: Partial<Record<ErrorCode, string>> = {};
  for (const [code, key] of Object.entries(keys) as [ErrorCode, MessageKey][]) out[code] = t(key);
  return out;
}

/** The page alert for a failed admin user action. */
export function adminUserError(err: unknown): string {
  return errorMessage(err, translated(ADMIN_USER_ERRORS));
}

/** The page alert for a failed voice disconnect (row 31). */
export function voiceDisconnectError(err: unknown): string {
  return errorMessage(err, translated(VOICE_DISCONNECT_ERRORS));
}

/** `data-testid="user-status"`. */
export type UserStatus = 'active' | 'deactivated';

export function userStatus(user: Pick<PublicUser, 'deactivated'>): UserStatus {
  return user.deactivated ? 'deactivated' : 'active';
}

export type AdminUserAction = 'makeAdmin' | 'removeAdmin' | 'resetCode' | 'deactivate' | 'reactivate';

/** A row button's label (the e2e specs find them by their English names). */
export function adminUserActionLabel(action: AdminUserAction, translate: TFunction = t): string {
  return translate(`admin.users.actions.${action}`);
}

/** The `user-role` text (`admin` / `member` in English, which the e2e specs read). */
export function userRoleLabel(role: PublicUser['role'], translate: TFunction = t): string {
  return translate(`admin.users.role.${role}`);
}

/** The `user-status` text (`active` / `deactivated` in English, which the e2e specs read). */
export function userStatusLabel(status: UserStatus, translate: TFunction = t): string {
  return translate(`admin.users.status.${status}`);
}

/**
 * A row's buttons, in order. An active user: the role toggle, a reset code and **Deactivate** (also on
 * our own row: the server's last-admin guard decides). A deactivated user can only be reactivated.
 */
export function userActions(user: Pick<PublicUser, 'role' | 'deactivated'>): AdminUserAction[] {
  if (user.deactivated) return ['reactivate'];
  return [user.role === 'admin' ? 'removeAdmin' : 'makeAdmin', 'resetCode', 'deactivate'];
}

/** Table order: by username in the UI language's collation (stable, so rows don't jump when a status changes). */
export function sortUsers(users: readonly PublicUser[]): PublicUser[] {
  return users.toSorted((a, b) => compare(a.username, b.username));
}

export type UsersChange =
  /** Row 35's response (or a `user:updated`): the user as the server has them now. */
  | { type: 'user'; user: PublicUser }
  /** Rows 36/37 answer 204: flip the flag until the refetch confirms it. */
  | { type: 'deactivated'; userId: string; deactivated: boolean };

/** The cached user list after `change`, as a new array (`undefined`, nothing cached yet, stays). */
export function reduceUsers(
  users: readonly PublicUser[] | undefined,
  change: UsersChange,
): PublicUser[] | undefined {
  if (users === undefined) return undefined;
  if (change.type === 'user') {
    const { user } = change;
    return users.some((u) => u.id === user.id)
      ? users.map((u) => (u.id === user.id ? user : u))
      : [...users, user];
  }
  const target = users.find((u) => u.id === change.userId);
  if (!target || target.deactivated === change.deactivated) return [...users];
  return users.map((u) => (u.id === change.userId ? { ...u, deactivated: change.deactivated } : u));
}
