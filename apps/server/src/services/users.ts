import { and, asc, count, eq, isNull } from 'drizzle-orm';
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
