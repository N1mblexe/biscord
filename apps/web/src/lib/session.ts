import type { QueryClient } from '@tanstack/react-query';
import { useMessageStore } from '../stores/messages';
import { useNoticeStore } from '../stores/notice';

/**
 * Drops every piece of per-session client state: cached server data, loaded messages, pending sends
 * and the app notice. Called on each way out of the signed-in app (logout, revoked or dead session)
 * rather than on unmount, which StrictMode simulates in development.
 */
export function clearSessionState(queryClient: QueryClient): void {
  queryClient.clear();
  useMessageStore.getState().reset();
  useNoticeStore.getState().clearNotice();
}
