import { z } from 'zod';
import { IsoDate, MessageId, Uuid } from '../ids.js';
import { LIMITS } from '../limits.js';
import { noNul } from '../text.js';
import { Role } from './common.js';

export const Invite = z.object({
  id: Uuid,
  code: z.string(),
  maxUses: z.number().int(),
  uses: z.number().int(),
  expiresAt: IsoDate,
  revokedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  createdBy: Uuid.nullable(),
});
export type Invite = z.infer<typeof Invite>;

/** GET `/admin/invites` */
export const InvitesResponse = z.object({ invites: z.array(Invite) });
export type InvitesResponse = z.infer<typeof InvitesResponse>;

/** POST `/admin/invites` */
export const InviteResponse = z.object({ invite: Invite });
export type InviteResponse = z.infer<typeof InviteResponse>;

/** POST `/admin/invites` */
export const CreateInviteRequest = z.object({
  maxUses: z.number().int().min(1).max(LIMITS.inviteMaxUses).default(1),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.inviteMaxExpiresHours)
    .default(LIMITS.inviteDefaultExpiresHours),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

/** PATCH `/admin/users/:id` */
export const UpdateUserRoleRequest = z.object({ role: Role });
export type UpdateUserRoleRequest = z.infer<typeof UpdateUserRoleRequest>;

/** POST `/admin/users/:id/reset-code` (code shown once, valid 24 h). */
export const ResetCodeResponse = z.object({
  code: z.string(),
  expiresAt: IsoDate,
});
export type ResetCodeResponse = z.infer<typeof ResetCodeResponse>;

/** POST `/__test__/reset` (test mode only). */
export const TestResetResponse = z.object({ adminInviteCode: z.string() });
export type TestResetResponse = z.infer<typeof TestResetResponse>;

/** POST `/__test__/seed-messages` (test mode only). Inserts messages directly, without broadcasts or rate limits. */
export const TestSeedMessagesRequest = z.object({
  channelId: Uuid,
  authorId: Uuid,
  count: z.number().int().min(1).max(500),
  prefix: noNul(z.string().min(1).max(32)).default('msg'),
});
export type TestSeedMessagesRequest = z.infer<typeof TestSeedMessagesRequest>;

export const TestSeedMessagesResponse = z.object({ firstId: MessageId, lastId: MessageId });
export type TestSeedMessagesResponse = z.infer<typeof TestSeedMessagesResponse>;
