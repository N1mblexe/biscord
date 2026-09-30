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
import { consumeResetCode, voidUnusedResetCodes } from './resetCodes.js';
import {
  createSession,
  deleteOtherUserSessions,
  deleteUserSessions,
  sessionStatus,
  type AuthContext,
  type CreatedSession,
} from './sessions.js';
import {
  countActiveUsers,
  findUserByUsername,
  lockUserRow,
  lockUserRowByUsername,
  lockUsers,
  updatePasswordHash,
} from './users.js';

export interface AuthConfig {
  maxUsers: number;
  sessionTtlDays: number;
}

export interface LoggedIn extends CreatedSession {
  user: UserRow;
}

const invalidCredentials = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 'Invalid username or password');
const invalidResetCode = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 'Invalid username or reset code');
const invalidCurrentPassword = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');

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
        .values({
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          role,
          // B.11 rule 3: the language the form was shown in; the column default (`en`) otherwise.
          ...(input.locale === undefined ? {} : { locale: input.locale }),
        })
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

/**
 * Always runs exactly one argon2 verify, so timing does not reveal whether the user exists.
 *
 * The verify runs outside any transaction; a reset, password change or deactivation may commit meanwhile.
 * So the session is created in a transaction that first locks the user row and re-checks that the verified
 * hash is still current and the user still active (CONTRACTS B.9 rule 3). Such a change either committed
 * before the lock (→ INVALID_CREDENTIALS) or waits for this commit and then deletes the new session too.
 */
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

  return db.transaction(async (tx) => {
    const current = await lockUserRow(tx, user.id);
    if (current === null || current.deactivatedAt !== null || current.passwordHash !== user.passwordHash) {
      throw invalidCredentials();
    }
    const session = await createSession(tx, current.id, config.sessionTtlDays, userAgent);
    return { ...session, user: current };
  });
}

/**
 * Consumes the reset code, sets the new password, voids the user's other unused codes and deletes every
 * session of the user. Returns the deleted session ids (the caller emits `session:revoked` after the commit).
 * Lock order (B.9 rule 3): the user row first, then the reset codes, as in deactivation.
 */
export async function resetPassword(db: Db, input: ResetPasswordRequest): Promise<string[]> {
  // Hashed up front: every attempt costs the same, whether or not the code is valid.
  const passwordHash = await hashPassword(input.newPassword);

  return db.transaction(async (tx) => {
    const user = await lockUserRowByUsername(tx, normalizeUsername(input.username));
    if (user === null || user.deactivatedAt !== null) throw invalidResetCode();
    if (!(await consumeResetCode(tx, user.id, input.code))) throw invalidResetCode();
    await updatePasswordHash(tx, user.id, passwordHash);
    await voidUnusedResetCodes(tx, user.id);
    return deleteUserSessions(tx, user.id);
  });
}

/**
 * Verifies the current password, sets the new one, voids the user's unused reset codes and deletes every
 * other session of the user (the current one stays). Returns the deleted session ids.
 *
 * `auth` was resolved when the request arrived. Under the user row lock (B.9 rule 3) the transaction
 * re-checks that this session still exists (a concurrent change from another session, a reset or a
 * deactivation deleted it → UNAUTHENTICATED) and that the verified hash is still current (a concurrent
 * change from this same session → INVALID_CREDENTIALS).
 */
export async function changePassword(
  db: Db,
  auth: AuthContext,
  input: ChangePasswordRequest,
): Promise<string[]> {
  if (!(await verifyPassword(auth.user.passwordHash, input.currentPassword))) {
    throw invalidCurrentPassword();
  }
  const passwordHash = await hashPassword(input.newPassword);

  return db.transaction(async (tx) => {
    const current = await lockUserRow(tx, auth.user.id);
    if (current === null || (await sessionStatus(tx, current.id, auth.session.id)) !== 'live') {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    if (current.passwordHash !== auth.user.passwordHash) throw invalidCurrentPassword();
    await updatePasswordHash(tx, current.id, passwordHash);
    await voidUnusedResetCodes(tx, current.id);
    return deleteOtherUserSessions(tx, current.id, auth.session.id);
  });
}
