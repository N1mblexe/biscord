import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Role } from '@hearth/shared';
import { invites } from '../db/schema.js';
import type { InviteRow, Queryable } from '../db/types.js';
import { normalizeCode, randomCode } from '../lib/crypto.js';

export const INVITE_CODE_LENGTH = 16;
const HOUR_MS = 60 * 60 * 1000;

export interface CreateInviteInput {
  createdBy: string | null;
  maxUses: number;
  expiresInHours: number;
  grantsRole?: Role;
}

export async function createInvite(db: Queryable, input: CreateInviteInput): Promise<InviteRow> {
  const [row] = await db
    .insert(invites)
    .values({
      code: randomCode(INVITE_CODE_LENGTH),
      grantsRole: input.grantsRole ?? 'member',
      maxUses: input.maxUses,
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + input.expiresInHours * HOUR_MS),
    })
    .returning();
  if (row === undefined) throw new Error('invite insert returned no row');
  return row;
}

/** Newest first; includes used, expired and revoked invites. */
export function listInvites(db: Queryable): Promise<InviteRow[]> {
  return db.select().from(invites).orderBy(desc(invites.createdAt), desc(invites.id));
}

/**
 * Sets `revokedAt` if it is not set yet. Returns `false` if no invite has this id.
 * Revoking an already revoked invite is a no-op that keeps the original timestamp.
 */
export async function revokeInvite(db: Queryable, id: string): Promise<boolean> {
  const [updated] = await db
    .update(invites)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(invites.id, id), isNull(invites.revokedAt)))
    .returning({ id: invites.id });
  if (updated !== undefined) return true;
  const [existing] = await db.select({ id: invites.id }).from(invites).where(eq(invites.id, id));
  return existing !== undefined;
}

/** An invite can be redeemed: not revoked, not expired, uses left. */
export async function isInviteRedeemable(db: Queryable, code: string): Promise<boolean> {
  const [row] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.code, normalizeCode(code)),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, sql`now()`),
        lt(invites.uses, invites.maxUses),
      ),
    );
  return row !== undefined;
}

/**
 * Consumes one use of an invite with a single conditional UPDATE (race-free under concurrency).
 * Must run inside the registration transaction so a later failure rolls the use back.
 * Returns the role the invite grants, or `null` if it is invalid (unknown, used up, expired or revoked).
 */
export async function redeemInvite(tx: Queryable, code: string): Promise<Role | null> {
  const [row] = await tx
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(
      and(
        eq(invites.code, normalizeCode(code)),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, sql`now()`),
        lt(invites.uses, invites.maxUses),
      ),
    )
    .returning({ grantsRole: invites.grantsRole });
  return row?.grantsRole ?? null;
}
