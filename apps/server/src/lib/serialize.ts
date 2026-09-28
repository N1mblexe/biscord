import type { Invite, Me, PublicUser } from '@hearth/shared';
import type { InviteRow, UserRow } from '../db/types.js';

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: null, // avatars arrive in Phase 5
    role: row.role,
    deactivated: row.deactivatedAt !== null,
  };
}

export function toMe(row: UserRow): Me {
  return { ...toPublicUser(row), createdAt: row.createdAt.toISOString() };
}

export function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}
