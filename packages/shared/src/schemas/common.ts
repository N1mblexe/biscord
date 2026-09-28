import { z } from 'zod';
import { MessageId, Uuid } from '../ids.js';

export const Username = z.string().regex(/^[a-z0-9_]{3,32}$/);
export type Username = z.infer<typeof Username>;

export const DisplayName = z.string().trim().min(1).max(32);
export type DisplayName = z.infer<typeof DisplayName>;

export const Password = z.string().min(10).max(128);
export type Password = z.infer<typeof Password>;

export const ChannelName = z.string().trim().min(1).max(32);
export type ChannelName = z.infer<typeof ChannelName>;

export const Role = z.enum(['admin', 'member']);
export type Role = z.infer<typeof Role>;

/** Non-DM channel type. DMs are modelled separately as `DmChannel` (`type: 'dm'`). */
export const ChannelType = z.enum(['text', 'voice']);
export type ChannelType = z.infer<typeof ChannelType>;

// ---- Route params (B.4) ----

/** `/channels/:id`, `/admin/invites/:id`, `/admin/users/:id/...` */
export const IdParams = z.object({ id: Uuid });
export type IdParams = z.infer<typeof IdParams>;

/** `/messages/:id` */
export const MessageIdParams = z.object({ id: MessageId });
export type MessageIdParams = z.infer<typeof MessageIdParams>;

/** `/voice/:channelId/token` */
export const ChannelIdParams = z.object({ channelId: Uuid });
export type ChannelIdParams = z.infer<typeof ChannelIdParams>;

/** `/avatars/:userId` */
export const UserIdParams = z.object({ userId: Uuid });
export type UserIdParams = z.infer<typeof UserIdParams>;

/** `/voice/:channelId/participants/:userId/disconnect` */
export const VoiceParticipantParams = z.object({ channelId: Uuid, userId: Uuid });
export type VoiceParticipantParams = z.infer<typeof VoiceParticipantParams>;

/** `/invites/:code/check` */
export const InviteCodeParams = z.object({ code: z.string().min(1).max(32) });
export type InviteCodeParams = z.infer<typeof InviteCodeParams>;

/** `/attachments/:id/:filename` */
export const AttachmentParams = z.object({ id: Uuid, filename: z.string().min(1).max(255) });
export type AttachmentParams = z.infer<typeof AttachmentParams>;

/** `/avatars/:userId?v=` (cache-buster, ignored by the server). */
export const AvatarQuery = z.object({ v: z.string().optional() });
export type AvatarQuery = z.infer<typeof AvatarQuery>;
