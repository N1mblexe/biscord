import { and, eq, ne } from 'drizzle-orm';
import { sessions, users } from '../db/schema.js';
import type { Queryable, SessionRow, UserRow } from '../db/types.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `lastSeenAt` / `expiresAt` are bumped at most once per this interval (sliding expiry). */
export const SESSION_BUMP_INTERVAL_MS = 60 * 60 * 1000;
const USER_AGENT_MAX = 255;

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

/** `resolveSession`'s result: `bumped` is true when this call slid `expiresAt` (the cookie should be re-sent). */
export interface ResolvedSession extends AuthContext {
  bumped: boolean;
}

export interface CreatedSession {
  /** The raw cookie value. Only its sha256 is stored. */
  token: string;
  session: SessionRow;
}

function expiryFrom(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * DAY_MS);
}

export async function createSession(
  db: Queryable,
  userId: string,
  ttlDays: number,
  userAgent: string | undefined,
): Promise<CreatedSession> {
  const token = randomToken();
  const now = new Date();
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256Hex(token),
      userAgent: userAgent?.slice(0, USER_AGENT_MAX) ?? null,
      lastSeenAt: now,
      expiresAt: expiryFrom(now, ttlDays),
    })
    .returning();
  if (session === undefined) throw new Error('session insert returned no row');
  return { token, session };
}

/**
 * Resolves a cookie token to its session and user.
 * - Unknown token → `null`.
 * - Expired session → deleted (lazily) and `null`.
 * - Deactivated user → `null`.
 * - Otherwise the sliding expiry is bumped if the last bump is at least an hour old, and `bumped` says so.
 */
export async function resolveSession(
  db: Queryable,
  token: string,
  ttlDays: number,
): Promise<ResolvedSession | null> {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256Hex(token)))
    .limit(1);
  if (row === undefined) return null;

  const now = new Date();
  if (row.session.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }
  if (row.user.deactivatedAt !== null) return null;

  if (now.getTime() - row.session.lastSeenAt.getTime() >= SESSION_BUMP_INTERVAL_MS) {
    const [bumped] = await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: expiryFrom(now, ttlDays) })
      .where(eq(sessions.id, row.session.id))
      .returning();
    if (bumped === undefined) return null; // deleted concurrently (logout, password change)
    return { user: row.user, session: bumped, bumped: true };
  }
  return { user: row.user, session: row.session, bumped: false };
}

/** Deletes one session. Returns the ids actually deleted (empty if it was already gone). */
export async function deleteSession(db: Queryable, sessionId: string): Promise<string[]> {
  const rows = await db.delete(sessions).where(eq(sessions.id, sessionId)).returning({ id: sessions.id });
  return rows.map((row) => row.id);
}

/** Deletes every session of a user. Returns the deleted ids. */
export async function deleteUserSessions(db: Queryable, userId: string): Promise<string[]> {
  const rows = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return rows.map((row) => row.id);
}

/** Deletes every session of a user except `keepSessionId`. Returns the deleted ids. */
export async function deleteOtherUserSessions(
  db: Queryable,
  userId: string,
  keepSessionId: string,
): Promise<string[]> {
  const rows = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .returning({ id: sessions.id });
  return rows.map((row) => row.id);
}
