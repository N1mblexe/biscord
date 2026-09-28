import {
  InviteResponse,
  InvitesResponse,
  ResetCodeResponse,
  UsersResponse,
  type CreateInviteRequest,
  type Invite,
  type PublicUser,
} from '@hearth/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from './client';

export const usersQueryKey = ['users'] as const;
export const invitesQueryKey = ['admin', 'invites'] as const;

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

export function generateResetCode(userId: string): Promise<ResetCodeResponse> {
  return apiFetch(`/admin/users/${encodeURIComponent(userId)}/reset-code`, {
    method: 'POST',
    schema: ResetCodeResponse,
  });
}
