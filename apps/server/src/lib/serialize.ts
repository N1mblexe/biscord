import {
  INLINE_IMAGE_MIME_TYPES,
  type Attachment,
  type Channel,
  type DmChannel,
  type Invite,
  type Me,
  type Message,
  type PublicUser,
  type Reaction,
} from '@hearth/shared';
import type { AttachmentRow, ChannelRow, InviteRow, MessageRow, UserRow } from '../db/types.js';

const AVATAR_KEY_PREFIX = 'avatars/';

/** B.7a rule 5: `/api/avatars/<userId>?v=<first 8 chars of the storage uuid>`, or `null`. */
export function avatarUrl(row: Pick<UserRow, 'id' | 'avatarKey'>): string | null {
  const key = row.avatarKey;
  if (key?.startsWith(AVATAR_KEY_PREFIX) !== true) return null;
  return `/api/avatars/${row.id}?v=${key.slice(AVATAR_KEY_PREFIX.length, AVATAR_KEY_PREFIX.length + 8)}`;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: avatarUrl(row),
    role: row.role,
    deactivated: row.deactivatedAt !== null,
  };
}

/** The signed-in user, including the private `locale` (B.11 rule 2). Never broadcast; use `toPublicUser`. */
export function toMe(row: UserRow): Me {
  return { ...toPublicUser(row), createdAt: row.createdAt.toISOString(), locale: row.locale };
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

/** Served with `Content-Disposition: inline` and its own `Content-Type` (B.7a rule 4). */
export function isInlineImage(mimeType: string): boolean {
  return (INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** `url` = `/api/attachments/<id>/<encoded filename>`; `inline` from the image allowlist. */
export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: `/api/attachments/${row.id}/${encodeURIComponent(row.filename)}`,
    inline: isInlineImage(row.mimeType),
  };
}

/** Per-message aggregates loaded alongside the row (batch-loaded, see `services/messages.ts`). */
export interface MessageExtras {
  attachments: Attachment[];
  reactions: Reaction[];
  mentionUserIds: string[];
}

export function toMessage(
  row: MessageRow,
  extras: MessageExtras = { attachments: [], reactions: [], mentionUserIds: [] },
): Message {
  return {
    id: String(row.id),
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    attachments: extras.attachments,
    reactions: extras.reactions,
    mentionUserIds: extras.mentionUserIds,
    nonce: row.nonce,
  };
}
