import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** Client errors (4xx) won't change on retry; network and 5xx errors get two more attempts. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetry,
    },
    mutations: {
      retry: false,
    },
  },
});
