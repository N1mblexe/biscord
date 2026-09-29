import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { LIMITS } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { passwordResetCodes, users } from '../db/schema.js';
import type { Queryable } from '../db/types.js';
import { normalizeCode, randomCode, sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { findUserById, lockStillAdmin } from './users.js';

export const RESET_CODE_LENGTH = 12;
const HOUR_MS = 60 * 60 * 1000;

export interface IssuedResetCode {
  /** Plain code, shown to the admin once. Only its sha256 is stored. */
  code: string;
  expiresAt: Date;
}

/** Deletes every unused reset code of the user (a new code replaces them; deactivation voids them). */
export async function voidUnusedResetCodes(tx: Queryable, userId: string): Promise<void> {
  await tx
    .delete(passwordResetCodes)
    .where(and(eq(passwordResetCodes.userId, userId), isNull(passwordResetCodes.usedAt)));
}

/**
 * Row 38: issues a single-use reset code valid 24 h, the user's older unused codes invalidated (deleted).
 * `createdBy` must still be an admin when the transaction runs (B.7b rule 7, `FORBIDDEN` otherwise);
 * `NOT_FOUND` for an unknown user.
 */
export async function issueResetCode(db: Db, userId: string, createdBy: string): Promise<IssuedResetCode> {
  const code = randomCode(RESET_CODE_LENGTH);
  const expiresAt = new Date(Date.now() + LIMITS.resetCodeTtlHours * HOUR_MS);
  await db.transaction(async (tx) => {
    await lockStillAdmin(tx, createdBy);
    if ((await findUserById(tx, userId)) === null) throw new AppError('NOT_FOUND', 'User not found');
    await voidUnusedResetCodes(tx, userId);
    await tx.insert(passwordResetCodes).values({ userId, codeHash: sha256Hex(code), createdBy, expiresAt });
  });
  return { code, expiresAt };
}

/**
 * Marks the code used if it belongs to the active user `username`, is unused and unexpired.
 * One conditional UPDATE, so a code can never be used twice. Returns the user id, or `null`.
 */
export async function consumeResetCode(
  tx: Queryable,
  username: string,
  code: string,
): Promise<string | null> {
  const [row] = await tx
    .update(passwordResetCodes)
    .set({ usedAt: sql`now()` })
    .from(users)
    .where(
      and(
        eq(users.id, passwordResetCodes.userId),
        eq(users.username, username),
        isNull(users.deactivatedAt),
        eq(passwordResetCodes.codeHash, sha256Hex(normalizeCode(code))),
        isNull(passwordResetCodes.usedAt),
        gt(passwordResetCodes.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: passwordResetCodes.userId });
  return row?.userId ?? null;
}
