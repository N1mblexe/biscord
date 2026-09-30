import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { LIMITS } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { passwordResetCodes } from '../db/schema.js';
import type { Queryable } from '../db/types.js';
import { normalizeCode, randomCode, sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { lockStillAdmin, lockUserRow } from './users.js';

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
    // B.9 rule 3: the user row lock serializes concurrent issuances (and resets), so exactly one code is left.
    if ((await lockUserRow(tx, userId)) === null) throw new AppError('NOT_FOUND', 'User not found');
    await voidUnusedResetCodes(tx, userId);
    await tx.insert(passwordResetCodes).values({ userId, codeHash: sha256Hex(code), createdBy, expiresAt });
  });
  return { code, expiresAt };
}

/**
 * Marks the code used if it belongs to `userId`, is unused and unexpired. One conditional UPDATE, so a code
 * can never be used twice. The caller holds the user's row lock (`lockUserRow`) and has checked the user is
 * active: the row lock comes before the code rows, the same order as deactivation (no deadlock).
 */
export async function consumeResetCode(tx: Queryable, userId: string, code: string): Promise<boolean> {
  const [row] = await tx
    .update(passwordResetCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(passwordResetCodes.userId, userId),
        eq(passwordResetCodes.codeHash, sha256Hex(normalizeCode(code))),
        isNull(passwordResetCodes.usedAt),
        gt(passwordResetCodes.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: passwordResetCodes.id });
  return row !== undefined;
}
