import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Queryable, UserRow } from '../db/types.js';

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
