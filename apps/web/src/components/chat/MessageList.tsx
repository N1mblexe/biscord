import type { BootstrapResponse, Me } from '@hearth/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/errors';
import { authorName } from '../../lib/bootstrapPatch';
import { loadLatest, loadOlder } from '../../lib/messageSync';
import { compareMessageIds, useMessageStore } from '../../stores/messages';
import { secondaryButton } from '../styles';
import { MessageItem, PendingItem } from './MessageItem';

/** Within this many px of the bottom counts as "at the bottom" (new messages keep it pinned). */
const BOTTOM_SLACK_PX = 48;
/**
 * The top sentinel must stay visible this long before older messages load on their own. Long enough
 * that a click on **Load older messages** (which scrolls the sentinel into view) wins the race.
 */
const AUTO_LOAD_DELAY_MS = 300;

interface Snapshot {
  firstId: string | undefined;
  /** Changes whenever something is appended at the bottom (a new message or a pending send). */
  tailKey: string;
  pendingCount: number;
  scrollHeight: number;
}

interface MessageListProps {
  channelId: string;
  boot: BootstrapResponse;
  me: Me;
  isDm: boolean;
  onError: (message: string | null) => void;
}

export function MessageList({ channelId, boot, me, isDm, onError }: MessageListProps) {
  const entry = useMessageStore((s) => s.channels[channelId]);
  const allPending = useMessageStore((s) => s.pending);
  const pending = useMemo(
    () => Object.values(allPending).filter((p) => p.channelId === channelId),
    [allPending, channelId],
  );
  const usersById = useMemo(() => new Map(boot.users.map((u) => [u.id, u])), [boot.users]);

  const loaded = entry?.loaded ?? false;
  const hasOlder = loaded && (entry?.hasOlder ?? false);
  const ids = useMemo(() => entry?.ids ?? [], [entry]);

  // First page (the entry buffers live events while it loads). A failure shows inline with a Retry
  // button; reconnect catch-up also retries it. The request is shared and harmless after unmount.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (loaded) return;
    let active = true;
    loadLatest(channelId).then(
      () => {
        if (active) setLoadError(null);
      },
      (err: unknown) => {
        if (active) setLoadError(errorMessage(err));
      },
    );
    return () => {
      active = false;
    };
  }, [channelId, loaded, loadAttempt]);
  const retryLoad = () => {
    setLoadError(null);
    setLoadAttempt((n) => n + 1);
  };

  const requestOlder = useCallback(() => {
    loadOlder(channelId).catch((err: unknown) => {
      onError(errorMessage(err));
    });
  }, [channelId, onError]);

  // ---- Scroll management ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const snapshotRef = useRef<Snapshot | null>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
  };

  // Runs after every render, before paint. The container has `overflow-anchor: none`, so the browser
  // never adjusts scrollTop by itself and the arithmetic below is exact.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next: Snapshot = {
      firstId: ids[0],
      tailKey: `${ids.at(-1) ?? ''}|${pending.at(-1)?.nonce ?? ''}`,
      pendingCount: pending.length,
      scrollHeight: el.scrollHeight,
    };
    const prev = snapshotRef.current;
    const wasEmpty = !prev || (prev.firstId === undefined && prev.pendingCount === 0);

    if (wasEmpty) {
      el.scrollTop = el.scrollHeight;
    } else if (
      prev.firstId !== undefined &&
      next.firstId !== undefined &&
      compareMessageIds(next.firstId, prev.firstId) < 0
    ) {
      // Older messages were prepended: keep the same messages under the viewport.
      el.scrollTop += el.scrollHeight - prev.scrollHeight;
    } else if (
      next.tailKey !== prev.tailKey &&
      (atBottomRef.current || next.pendingCount > prev.pendingCount)
    ) {
      // Something new at the bottom: follow it if we were at the bottom, or if it is our own send.
      el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    next.scrollHeight = el.scrollHeight;
    snapshotRef.current = next;
  });

  // Scrolling to the top loads older messages.
  useEffect(() => {
    const root = scrollRef.current;
    const target = topRef.current;
    if (!hasOlder || !root || !target) return;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        clearTimeout(timer);
        if (!visible) return;
        timer = setTimeout(() => {
          if (visible) requestOlder();
        }, AUTO_LOAD_DELAY_MS);
      },
      { root, rootMargin: '100px 0px 0px 0px' },
    );
    observer.observe(target);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [hasOlder, requestOlder]);

  const byId = entry?.byId ?? {};
  const isAdmin = me.role === 'admin';

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
      aria-label="Chat history"
      role="region"
    >
      <div ref={topRef} aria-hidden="true" className="h-px" />
      {hasOlder && (
        <div className="flex justify-center py-3">
          <button type="button" className={secondaryButton} onClick={requestOlder}>
            Load older messages
          </button>
        </div>
      )}
      {!loaded && loadError !== null ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-6 text-sm text-muted">
          <p data-testid="messages-load-error">Couldn’t load messages: {loadError}</p>
          <button type="button" className={secondaryButton} onClick={retryLoad}>
            Retry
          </button>
        </div>
      ) : !loaded ? (
        <p className="px-4 py-6 text-sm text-muted">Loading messages…</p>
      ) : ids.length === 0 && pending.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No messages yet. Say hello!</p>
      ) : (
        !hasOlder && (
          <p className="px-4 pt-6 pb-2 text-xs text-muted">This is the beginning of the conversation.</p>
        )
      )}
      <ol className="flex flex-col pb-2">
        {ids.map((id) => {
          const message = byId[id];
          if (!message) return null;
          const own = message.authorId === me.id;
          return (
            <MessageItem
              key={id}
              message={message}
              authorName={authorName(usersById.get(message.authorId))}
              canEdit={own}
              canDelete={own || (isAdmin && !isDm)}
              onError={onError}
            />
          );
        })}
        {pending.map((p) => (
          <PendingItem key={p.nonce} pending={p} authorName={me.displayName} onError={onError} />
        ))}
      </ol>
    </div>
  );
}
