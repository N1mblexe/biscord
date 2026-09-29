import { useEffect, useSyncExternalStore } from 'react';
import { markRead } from '../api/chat';
import { compareMessageIds } from '../stores/messages';
import { useReadsStore } from '../stores/reads';
import { isDocumentVisible, useViewingStore } from '../stores/viewing';

/** Read marking waits this long for things to settle (docs/plans/phase-4.md, "Unread logic"). */
export const MARK_READ_DEBOUNCE_MS = 500;

/** Delays before retrying a failed POST; after the last one it waits for the next trigger. */
export const MARK_READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/**
 * POSTs `/channels/:id/read` for `messageId` after the debounce, retrying a failure after each of
 * `MARK_READ_RETRY_DELAYS_MS`. The response is applied with the reads sequence from when its request
 * started (stores/reads.ts), so a mention that arrives while it is in flight still counts. Returns a
 * cancel function (pending timers only; a response in flight is still applied — it is authoritative).
 */
export function scheduleMarkRead(channelId: string, messageId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const attempt = (retry: number): void => {
    timer = undefined;
    const sinceSeq = useReadsStore.getState().seq;
    markRead(channelId, messageId).then(
      (readState) => {
        useReadsStore.getState().applyServer(readState, sinceSeq);
      },
      () => {
        const delay = MARK_READ_RETRY_DELAYS_MS[retry];
        if (cancelled || delay === undefined) return;
        timer = setTimeout(() => {
          attempt(retry + 1);
        }, delay);
      },
    );
  };

  timer = setTimeout(() => {
    attempt(0);
  }, MARK_READ_DEBOUNCE_MS);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
  };
}

/** `document.visibilityState === 'visible'`, re-rendering on `visibilitychange`. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, isDocumentVisible, () => true);
}

/**
 * While `channelId` is scrolled to the bottom in a visible tab, POSTs `/channels/:id/read` with the
 * newest loaded message (never a pending one), debounced, whenever that is newer than our read
 * state. Also fires when the tab becomes visible or the list reaches the bottom. The response (and
 * the `readstate:updated` echo to our other tabs) is authoritative; a failure is retried twice with
 * a backoff (`scheduleMarkRead`), then the next change retries.
 */
export function useMarkRead(channelId: string, newestId: string | undefined): void {
  const atBottom = useViewingStore((s) => s.channelId === channelId && s.atBottom);
  const visible = useDocumentVisible();
  const lastRead = useReadsStore((s) => s.channels[channelId]?.server.lastReadMessageId ?? '0');

  useEffect(() => {
    if (!atBottom || !visible || newestId === undefined) return;
    if (compareMessageIds(newestId, lastRead) <= 0) return;
    return scheduleMarkRead(channelId, newestId);
  }, [channelId, newestId, lastRead, atBottom, visible]);
}
