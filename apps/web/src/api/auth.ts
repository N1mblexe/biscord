import {
  UserResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type Me,
  type RegisterRequest,
  type ResetPasswordRequest,
  type UpdateMeRequest,
} from '@hearth/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from './client';

export const meQueryKey = ['me'] as const;

/** The signed-in user. A 401 means "not logged in". */
export const meQuery = queryOptions({
  queryKey: meQueryKey,
  queryFn: async ({ signal }): Promise<Me> => {
    const res = await apiFetch('/me', { schema: UserResponse, signal });
    return res.user;
  },
});

export async function login(body: LoginRequest): Promise<Me> {
  const res = await apiFetch('/auth/login', { method: 'POST', body, schema: UserResponse });
  return res.user;
}

export async function register(body: RegisterRequest): Promise<Me> {
  const res = await apiFetch('/auth/register', { method: 'POST', body, schema: UserResponse });
  return res.user;
}

export function logout(): Promise<undefined> {
  return apiFetch('/auth/logout', { method: 'POST' });
}

export function resetPassword(body: ResetPasswordRequest): Promise<undefined> {
  return apiFetch('/auth/reset-password', { method: 'POST', body });
}

export async function updateMe(body: UpdateMeRequest): Promise<Me> {
  const res = await apiFetch('/me', { method: 'PATCH', body, schema: UserResponse });
  return res.user;
}

export function changePassword(body: ChangePasswordRequest): Promise<undefined> {
  return apiFetch('/me/password', { method: 'POST', body });
}
