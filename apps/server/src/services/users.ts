import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { users } from '../db/schema.js';
import type { Queryable, UserRow } from '../db/types.js';

/**
 * Key for `pg_advisory_xact_lock` over the set of users: registrations (user cap + invite use), role changes
 * and (de/re)activations take it, so the user cap and the last-admin guard (B.7b rule 1) are checked against
 * a stable set. ASCII "HRTH".
 */
export const USERS_LOCK_KEY = 0x48525448;

export async function lockUsers(tx: Queryable): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${USERS_LOCK_KEY})`);
}

/**
 * The users lock in shared mode: it waits for (and then holds off) any registration, role change or
 * (de/re)activation, but not other shared holders, so admin mutations don't serialize among themselves.
 */
export async function lockUsersShared(tx: Queryable): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${USERS_LOCK_KEY})`);
}

/**
 * The actor's admin rights, re-read inside the transaction: `requireAdmin` checked them when the request
 * arrived, and a concurrent demotion or deactivation may have committed since. `FORBIDDEN` otherwise.
 * Call it under the users lock (exclusive or shared) so no such change can commit before this one does.
 */
export async function assertStillAdmin(tx: Queryable, actorId: string): Promise<void> {
  const [row] = await tx
    .select({ role: users.role, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, actorId));
  if (row?.role !== 'admin' || row.deactivatedAt !== null) throw new AppError('FORBIDDEN', 'Admins only');
}

/**
 * CONTRACTS B.7b rule 7: the start of every admin mutation's transaction outside the user lifecycle flows
 * (channels, invites, reset codes): the shared users lock, then `assertStillAdmin`.
 */
export async function lockStillAdmin(tx: Queryable, actorId: string): Promise<void> {
  await lockUsersShared(tx);
  await assertStillAdmin(tx, actorId);
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}

export async function findUserByUsername(db: Queryable, username: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.username, username));
  return row ?? null;
}

/** Every user, including deactivated ones, ordered by username. */
export function listUsers(db: Queryable): Promise<UserRow[]> {
  return db.select().from(users).orderBy(asc(users.username));
}

export async function countActiveUsers(db: Queryable): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(isNull(users.deactivatedAt));
  return row?.n ?? 0;
}

export async function hasActiveAdmin(db: Queryable): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.deactivatedAt)))
    .limit(1);
  return row !== undefined;
}

/** Active admins other than `exceptId` (the last-admin guard, B.7b rule 1). */
export async function countOtherActiveAdmins(db: Queryable, exceptId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.deactivatedAt), ne(users.id, exceptId)));
  return row?.n ?? 0;
}

/** Which of `ids` (valid UUIDs) belong to deactivated users. */
export async function listDeactivatedUserIds(db: Queryable, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNotNull(users.deactivatedAt)));
  return rows.map((row) => row.id);
}

export async function updateDisplayName(
  db: Queryable,
  id: string,
  displayName: string,
): Promise<UserRow | null> {
  const [row] = await db.update(users).set({ displayName }).where(eq(users.id, id)).returning();
  return row ?? null;
}

export async function updatePasswordHash(db: Queryable, id: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
}

export interface AvatarChange {
  user: UserRow;
  /** The replaced file's storage key, unlinked by the caller after the commit (B.7a rule 5). */
  previousKey: string | null;
}

/**
 * Sets (`key`) or clears (`null`) a user's avatar in one transaction, returning the updated row and the
 * previous key. The row lock serializes concurrent changes, so every replaced key is reported exactly once.
 * `null` when the user no longer exists.
 */
export function replaceAvatarKey(db: Db, id: string, key: string | null): Promise<AvatarChange | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, id))
      .for('update');
    if (current === undefined) return null;
    const [row] = await tx.update(users).set({ avatarKey: key }).where(eq(users.id, id)).returning();
    if (row === undefined) return null;
    return { user: row, previousKey: current.avatarKey };
  });
}
