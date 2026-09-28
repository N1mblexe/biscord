import { z } from 'zod';
import { DisplayName, Password, Username } from './common.js';
import { Me } from './users.js';

/** POST `/auth/register` */
export const RegisterRequest = z.object({
  // Lenient: an unknown/overlong code yields INVITE_INVALID from the server, not VALIDATION.
  inviteCode: z.string().trim().min(1).max(128),
  username: Username,
  displayName: DisplayName,
  password: Password,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

/**
 * POST `/auth/login`. Deliberately lenient (no Username/Password format rules) so a malformed
 * credential yields INVALID_CREDENTIALS rather than VALIDATION.
 */
export const LoginRequest = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** POST `/auth/reset-password` */
export const ResetPasswordRequest = z.object({
  username: z.string().min(1).max(128),
  code: z.string().trim().min(1).max(64),
  newPassword: Password,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

/** GET `/invites/:code/check` */
export const InviteCheckResponse = z.object({ valid: z.boolean() });
export type InviteCheckResponse = z.infer<typeof InviteCheckResponse>;

/** `{ user: Me }` — register, login, GET/PATCH `/me`, avatar PUT/DELETE. */
export const UserResponse = z.object({ user: Me });
export type UserResponse = z.infer<typeof UserResponse>;

/** PATCH `/me` */
export const UpdateMeRequest = z.object({ displayName: DisplayName });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

/** POST `/me/password` */
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
