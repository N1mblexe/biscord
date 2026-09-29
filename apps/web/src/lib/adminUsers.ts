import type { ErrorCode, PublicUser } from '@hearth/shared';
import { errorMessage } from '../api/errors';

/**
 * `/admin/users` (docs/plans/phase-8.md, "Web UI contract"): which actions a row offers, their
 * labels, the error texts, and how the cached user list changes after an action.
 */

/** Fixed alert texts for the admin user actions (rows 35–37). */
export const ADMIN_USER_ERRORS = {
  LAST_ADMIN: "You can't remove the last admin.",
  USER_LIMIT: 'The account limit has been reached.',
} as const satisfies Partial<Record<ErrorCode, string>>;

/** The page alert for a failed admin user action. */
export function adminUserError(err: unknown): string {
  return errorMessage(err, ADMIN_USER_ERRORS);
}

/**
 * Row 31 (admin voice disconnect). A 503 may come after the server already sent the `voice:kicked` notice
 * (only LiveKit's `removeParticipant` failed), so the text must not claim that nothing happened.
 */
export const VOICE_DISCONNECT_ERRORS = {
  LIVEKIT_UNAVAILABLE: "LiveKit didn't confirm the disconnect; they may already be disconnected.",
} as const satisfies Partial<Record<ErrorCode, string>>;

/** The page alert for a failed voice disconnect (row 31). */
export function voiceDisconnectError(err: unknown): string {
  return errorMessage(err, VOICE_DISCONNECT_ERRORS);
}

/** `data-testid="user-status"`. */
export type UserStatus = 'active' | 'deactivated';

export function userStatus(user: Pick<PublicUser, 'deactivated'>): UserStatus {
  return user.deactivated ? 'deactivated' : 'active';
}

export type AdminUserAction = 'makeAdmin' | 'removeAdmin' | 'resetCode' | 'deactivate' | 'reactivate';

/** Button labels (the e2e specs find them by these exact names). */
export const ADMIN_USER_ACTION_LABELS: Readonly<Record<AdminUserAction, string>> = {
  makeAdmin: 'Make admin',
  removeAdmin: 'Remove admin',
  resetCode: 'Generate reset code',
  deactivate: 'Deactivate',
  reactivate: 'Reactivate',
};

/**
 * A row's buttons, in order. An active user: the role toggle, a reset code and **Deactivate** (also on
 * our own row: the server's last-admin guard decides). A deactivated user can only be reactivated.
 */
export function userActions(user: Pick<PublicUser, 'role' | 'deactivated'>): AdminUserAction[] {
  if (user.deactivated) return ['reactivate'];
  return [user.role === 'admin' ? 'removeAdmin' : 'makeAdmin', 'resetCode', 'deactivate'];
}

/** Table order: by username (stable, so rows don't jump when a status changes). */
export function sortUsers(users: readonly PublicUser[]): PublicUser[] {
  return users.toSorted((a, b) => a.username.localeCompare(b.username));
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
