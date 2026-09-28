import type { Channel, DmChannel, Invite, Me, Message, PublicUser } from '@hearth/shared';
import type { ChannelRow, InviteRow, MessageRow, UserRow } from '../db/types.js';

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

/** A text or voice channel. DM rows are serialized with `toDmChannel` instead. */
export function toChannel(row: ChannelRow): Channel {
  if (row.type === 'dm' || row.name === null) throw new Error(`channel ${row.id} is a DM`);
  return { id: row.id, type: row.type, name: row.name, position: row.position };
}

/** A DM from one member's point of view: `otherUserId` is the other member. */
export function toDmChannel(channelId: string, otherUserId: string): DmChannel {
  return { id: channelId, type: 'dm', otherUserId };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: String(row.id),
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    attachments: [], // Phase 5
    reactions: [], // Phase 4
    mentionUserIds: [], // Phase 4
    nonce: row.nonce,
  };
}
