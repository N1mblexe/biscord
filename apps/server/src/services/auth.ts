import type {
  ChangePasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from '@hearth/shared';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { isUniqueViolation, type UserRow } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { isInviteRedeemable, redeemInvite } from './invites.js';
import { hashPassword, verifyDummy, verifyPassword } from './passwords.js';
import { consumeResetCode } from './resetCodes.js';
import {
  createSession,
  deleteOtherUserSessions,
  deleteUserSessions,
  type AuthContext,
  type CreatedSession,
} from './sessions.js';
import { countActiveUsers, findUserByUsername, lockUsers, updatePasswordHash } from './users.js';

export interface AuthConfig {
  maxUsers: number;
  sessionTtlDays: number;
}

export interface LoggedIn extends CreatedSession {
  user: UserRow;
}

const invalidCredentials = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 'Invalid username or password');

/** Login and reset accept any case / surrounding spaces; stored usernames are lower case. */
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

const inviteInvalid = (): AppError => new AppError('INVITE_INVALID', 'This invite is invalid or has expired');

/**
 * Registration:
 * 1. A cheap read rejects a bad invite before any argon2 work (unauthenticated callers can't burn CPU with
 *    garbage codes).
 * 2. Hash the password, outside the transaction.
 * 3. One transaction: advisory lock → user cap → conditional invite use (the atomic re-check; the invite may
 *    have been used up since step 1) → insert user → create session. Any failure rolls the invite use back.
 */
export async function register(
  db: Db,
  config: AuthConfig,
  input: RegisterRequest,
  userAgent: string | undefined,
): Promise<LoggedIn> {
  if (!(await isInviteRedeemable(db, input.inviteCode))) throw inviteInvalid();

  // Hash outside the transaction so the advisory lock is never held across argon2.
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    // The users lock: also taken by reactivation, which checks the same cap (B.7b).
    await lockUsers(tx);

    if ((await countActiveUsers(tx)) >= config.maxUsers) {
      throw new AppError('USER_LIMIT', 'This server has reached its user limit');
    }

    const role = await redeemInvite(tx, input.inviteCode);
    if (role === null) throw inviteInvalid();

    let user: UserRow | undefined;
    try {
      [user] = await tx
        .insert(users)
        .values({ username: input.username, displayName: input.displayName, passwordHash, role })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err, 'users_username_unique')) {
        throw new AppError('USERNAME_TAKEN', 'That username is already taken');
      }
      throw err;
    }
    if (user === undefined) throw new Error('user insert returned no row');

    const session = await createSession(tx, user.id, config.sessionTtlDays, userAgent);
    return { ...session, user };
  });
}

/** Always runs exactly one argon2 verify, so timing does not reveal whether the user exists. */
export async function login(
  db: Db,
  config: AuthConfig,
  input: LoginRequest,
  userAgent: string | undefined,
): Promise<LoggedIn> {
  const user = await findUserByUsername(db, normalizeUsername(input.username));
  const ok =
    user === null
      ? await verifyDummy(input.password)
      : await verifyPassword(user.passwordHash, input.password);
  if (user === null || !ok || user.deactivatedAt !== null) throw invalidCredentials();

  const session = await createSession(db, user.id, config.sessionTtlDays, userAgent);
  return { ...session, user };
}

/**
 * Consumes the reset code, sets the new password and deletes every session of the user.
 * Returns the deleted session ids (the caller emits `session:revoked` after this commits).
 */
export async function resetPassword(db: Db, input: ResetPasswordRequest): Promise<string[]> {
  // Hashed up front: every attempt costs the same, whether or not the code is valid.
  const passwordHash = await hashPassword(input.newPassword);

  return db.transaction(async (tx) => {
    const userId = await consumeResetCode(tx, normalizeUsername(input.username), input.code);
    if (userId === null) throw new AppError('INVALID_CREDENTIALS', 'Invalid username or reset code');
    await updatePasswordHash(tx, userId, passwordHash);
    return deleteUserSessions(tx, userId);
  });
}

/**
 * Verifies the current password, sets the new one and deletes every other session of the user
 * (the current one stays). Returns the deleted session ids.
 */
export async function changePassword(
  db: Db,
  auth: AuthContext,
  input: ChangePasswordRequest,
): Promise<string[]> {
  if (!(await verifyPassword(auth.user.passwordHash, input.currentPassword))) {
    throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
  }
  const passwordHash = await hashPassword(input.newPassword);

  return db.transaction(async (tx) => {
    await updatePasswordHash(tx, auth.user.id, passwordHash);
    return deleteOtherUserSessions(tx, auth.user.id, auth.session.id);
  });
}
