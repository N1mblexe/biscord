import {
  InviteResponse,
  InvitesResponse,
  PublicUserResponse,
  ResetCodeResponse,
  UsersResponse,
  type CreateInviteRequest,
  type Invite,
  type PublicUser,
  type Role,
  type UpdateUserRoleRequest,
} from '@hearth/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from './client';

export const usersQueryKey = ['users'] as const;
export const invitesQueryKey = ['admin', 'invites'] as const;

const adminUserPath = (userId: string) => `/admin/users/${encodeURIComponent(userId)}`;

/** GET /users (any signed-in user; includes deactivated users). */
export const usersQuery = queryOptions({
  queryKey: usersQueryKey,
  queryFn: async ({ signal }): Promise<PublicUser[]> => {
    const res = await apiFetch('/users', { schema: UsersResponse, signal });
    return res.users;
  },
});

/** GET /admin/invites, newest first. */
export const invitesQuery = queryOptions({
  queryKey: invitesQueryKey,
  queryFn: async ({ signal }): Promise<Invite[]> => {
    const res = await apiFetch('/admin/invites', { schema: InvitesResponse, signal });
    return res.invites.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

export async function createInvite(body: CreateInviteRequest): Promise<Invite> {
  const res = await apiFetch('/admin/invites', { method: 'POST', body, schema: InviteResponse });
  return res.invite;
}

export function revokeInvite(id: string): Promise<undefined> {
  return apiFetch(`/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /admin/users/:id/reset-code (row 38): shown once, valid 24 h. */
export function generateResetCode(userId: string): Promise<ResetCodeResponse> {
  return apiFetch(`${adminUserPath(userId)}/reset-code`, {
    method: 'POST',
    schema: ResetCodeResponse,
  });
}

/** PATCH /admin/users/:id (row 35) → the updated user. LAST_ADMIN when demoting the last admin. */
export async function setUserRole(userId: string, role: Role): Promise<PublicUser> {
  const body: UpdateUserRoleRequest = { role };
  const res = await apiFetch(adminUserPath(userId), { method: 'PATCH', body, schema: PublicUserResponse });
  return res.user;
}

/** POST /admin/users/:id/deactivate (row 36): 204, idempotent. LAST_ADMIN for the last admin. */
export function deactivateUser(userId: string): Promise<undefined> {
  return apiFetch(`${adminUserPath(userId)}/deactivate`, { method: 'POST' });
}

/** POST /admin/users/:id/reactivate (row 37): 204, idempotent. USER_LIMIT at the account cap. */
export function reactivateUser(userId: string): Promise<undefined> {
  return apiFetch(`${adminUserPath(userId)}/reactivate`, { method: 'POST' });
}
