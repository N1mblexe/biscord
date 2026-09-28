import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { LIMITS } from '@hearth/shared';
import type { Db } from '../db/client.js';
import { passwordResetCodes, users } from '../db/schema.js';
import type { Queryable } from '../db/types.js';
import { normalizeCode, randomCode, sha256Hex } from '../lib/crypto.js';

export const RESET_CODE_LENGTH = 12;
const HOUR_MS = 60 * 60 * 1000;

export interface IssuedResetCode {
  /** Plain code, shown to the admin once. Only its sha256 is stored. */
  code: string;
  expiresAt: Date;
}

/** Issues a single-use reset code valid 24 h. The user's older unused codes are invalidated (deleted). */
export async function issueResetCode(db: Db, userId: string, createdBy: string): Promise<IssuedResetCode> {
  const code = randomCode(RESET_CODE_LENGTH);
  const expiresAt = new Date(Date.now() + LIMITS.resetCodeTtlHours * HOUR_MS);
  await db.transaction(async (tx) => {
    await tx
      .delete(passwordResetCodes)
      .where(and(eq(passwordResetCodes.userId, userId), isNull(passwordResetCodes.usedAt)));
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
