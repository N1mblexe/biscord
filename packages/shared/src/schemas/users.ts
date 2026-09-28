import { z } from 'zod';
import { IsoDate, Uuid } from '../ids.js';
import { DisplayName, Role, Username } from './common.js';

export const PublicUser = z.object({
  id: Uuid,
  username: Username,
  displayName: DisplayName,
  avatarUrl: z.string().nullable(),
  role: Role,
  deactivated: z.boolean(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const Me = PublicUser.extend({
  createdAt: IsoDate,
});
export type Me = z.infer<typeof Me>;

/** GET `/users` */
export const UsersResponse = z.object({ users: z.array(PublicUser) });
export type UsersResponse = z.infer<typeof UsersResponse>;

/** PATCH `/admin/users/:id` */
export const PublicUserResponse = z.object({ user: PublicUser });
export type PublicUserResponse = z.infer<typeof PublicUserResponse>;
