import { z } from 'zod';
import { lenientText } from '../text.js';
import { DisplayName, Password, Username } from './common.js';
import { Me } from './users.js';

/** POST `/auth/register` */
export const RegisterRequest = z.object({
  // Lenient: an unknown code (or one with a NUL) yields INVITE_INVALID from the server, not VALIDATION.
  inviteCode: lenientText(128, { trim: true }),
  username: Username,
  displayName: DisplayName,
  password: Password,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

/**
 * POST `/auth/login`. Deliberately lenient (no Username/Password format rules) so a malformed
 * credential (including one with a NUL, B.9 rule 1) yields INVALID_CREDENTIALS rather than VALIDATION.
 */
export const LoginRequest = z.object({
  username: lenientText(128),
  password: lenientText(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** POST `/auth/reset-password` */
export const ResetPasswordRequest = z.object({
  // Lenient, like login: a malformed username or code yields INVALID_CREDENTIALS.
  username: lenientText(128),
  code: lenientText(64, { trim: true }),
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
  // Lenient: a malformed current password yields INVALID_CREDENTIALS.
  currentPassword: lenientText(128),
  newPassword: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
