import type { BootstrapResponse, Me, Message } from '@hearth/shared';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { errorMessage } from '../../api/errors';
import { useLocale, useT } from '../../i18n';
import { authorName } from '../../lib/bootstrapPatch';
import { timelineMeta, type TimelineInput } from '../../lib/chatTimeline';
import { emptyChannelCopy } from '../../lib/emptyStates';
import { loadLatest, loadOlder } from '../../lib/messageSync';
import { useMarkRead } from '../../lib/readMarking';
import { compareMessageIds, useMessageStore, type PendingMessage } from '../../stores/messages';
import { useViewingStore } from '../../stores/viewing';
import { EmptyState } from '../EmptyState';
import { MessageListSkeleton } from '../Skeleton';
import { secondaryButton } from '../styles';
import { MessageItem, PendingItem } from './MessageItem';

/** Within this many px of the bottom counts as "at the bottom" (new messages keep it pinned). */
const BOTTOM_SLACK_PX = 48;
/**
 * The top sentinel must stay visible this long before older messages load on their own. Long enough
 * that a click on **Load older messages** (which scrolls the sentinel into view) wins the race; the
 * loser is a no-op either way (`loadOlder`'s `expectedOldest`).
 */
const AUTO_LOAD_DELAY_MS = 300;

interface Snapshot {
  firstId: string | undefined;
  /** Changes whenever something is appended at the bottom (a new message or a pending send). */
  tailKey: string;
  pendingCount: number;
  scrollHeight: number;
}

/** One row of the history: a loaded message or one of our pending sends. */
type Row = { kind: 'message'; message: Message } | { kind: 'pending'; pending: PendingMessage };

interface MessageListProps {
  channelId: string;
  boot: BootstrapResponse;
  me: Me;
  isDm: boolean;
  /** For the empty state: the channel name (without `#`) or, in a DM, the other person's name. */
  name: string;
  /** False in a read-only DM (the other member is deactivated). */
  canReact: boolean;
  onError: (message: string | null) => void;
}

export function MessageList({ channelId, boot, me, isDm, name, canReact, onError }: MessageListProps) {
  const t = useT();
  const [locale] = useLocale();
  const entry = useMessageStore((s) => s.channels[channelId]);
  const allPending = useMessageStore((s) => s.pending);
  const pending = useMemo(
    () => Object.values(allPending).filter((p) => p.channelId === channelId),
    [allPending, channelId],
  );
  const usersById = useMemo(() => new Map(boot.users.map((u) => [u.id, u])), [boot.users]);
  // Mentionable usernames, as the server sees them (CONTRACTS B.5a rule 2): active users only.
  const usernames = useMemo(
    () => new Set(boot.users.filter((u) => !u.deactivated).map((u) => u.username.toLowerCase())),
    [boot.users],
  );

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

  /** One older page before `expectedOldest` (a no-op if that page already landed meanwhile). */
  const requestOlder = useCallback(
    (expectedOldest: string | undefined) => {
      loadOlder(channelId, expectedOldest).catch((err: unknown) => {
        onError(errorMessage(err));
      });
    },
    [channelId, onError],
  );
  const loadOlderButtonRef = useRef<HTMLButtonElement>(null);

  // ---- Scroll management ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const snapshotRef = useRef<Snapshot | null>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    useViewingStore.getState().setViewing(channelId, atBottomRef.current);
  };

  // This channel is on screen until the list unmounts (a layout cleanup, so it runs before the next
  // channel's list registers itself).
  useLayoutEffect(
    () => () => {
      useViewingStore.getState().leave(channelId);
    },
    [channelId],
  );

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
    useViewingStore.getState().setViewing(channelId, atBottomRef.current);
  });

  // Content that grows after render (an image finishing loading) keeps a list at the bottom pinned
  // there, and keeps the snapshot height current for the prepend arithmetic above.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      if (snapshotRef.current) snapshotRef.current.scrollHeight = el.scrollHeight;
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Reading at the bottom of a visible tab marks the newest loaded message read.
  useMarkRead(channelId, loaded ? ids.at(-1) : undefined);

  // ---- Jump to latest ----
  // `seenThrough` follows the newest message while the list is at the bottom; messages newer than it
  // arrived while scrolled up and are counted on the pill. (Adjusted during render: it is derived
  // from the viewing store, which the scroll handler and the layout effect above keep current.)
  const atBottom = useViewingStore((s) => s.channelId === channelId && s.atBottom);
  const newestId = loaded ? ids.at(-1) : undefined;
  const [seenThrough, setSeenThrough] = useState<string | undefined>(newestId);
  if ((atBottom || seenThrough === undefined) && seenThrough !== newestId) setSeenThrough(newestId);
  const newCount = useMemo(
    () => (seenThrough === undefined ? 0 : ids.filter((id) => compareMessageIds(id, seenThrough) > 0).length),
    [ids, seenThrough],
  );
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    onScroll(); // at the bottom now: read marking and the pill follow at once
    document.getElementById('composer-input')?.focus({ preventScroll: true });
  };

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
        // The oldest id when the sentinel came into view: if a click loads that page first, this
        // auto-load does nothing instead of loading the page after it.
        const oldest = useMessageStore.getState().channels[channelId]?.ids[0];
        timer = setTimeout(() => {
          // A keyboard user on the button loads pages with it; the button scrolling the sentinel
          // into view must not load one more on its own.
          if (!visible || document.activeElement === loadOlderButtonRef.current) return;
          requestOlder(oldest);
        }, AUTO_LOAD_DELAY_MS);
      },
      { root, rootMargin: '100px 0px 0px 0px' },
    );
    observer.observe(target);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [hasOlder, requestOlder, channelId]);

  const isAdmin = me.role === 'admin';
  const viewer = useMemo(() => ({ id: me.id, username: me.username }), [me.id, me.username]);

  // The loaded messages, then our pending sends, with day separators and author grouping.
  const rows = useMemo(() => {
    const messages: Message[] = [];
    for (const id of ids) {
      const message = entry?.byId[id];
      if (message) messages.push(message);
    }
    const items: (TimelineInput & { row: Row })[] = [
      ...messages.map((message) => ({ ...message, row: { kind: 'message' as const, message } })),
      ...pending.map((p) => ({ ...p, row: { kind: 'pending' as const, pending: p } })),
    ];
    const meta = timelineMeta(items, new Date(), locale);
    return items.map((item, i) => ({ ...item.row, ...(meta[i] ?? { separator: null, grouped: false }) }));
  }, [ids, entry, pending, locale]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        aria-label={t('chat.history.label')}
        role="region"
      >
        <div ref={topRef} aria-hidden="true" className="h-px" />
        {hasOlder && (
          <div className="flex justify-center py-3">
            <button
              ref={loadOlderButtonRef}
              type="button"
              className={secondaryButton}
              onClick={() => {
                requestOlder(ids[0]);
              }}
            >
              {t('chat.history.loadOlder')}
            </button>
          </div>
        )}
        {!loaded && loadError !== null ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-6 text-sm text-muted">
            <p data-testid="messages-load-error">{t('chat.history.loadError', { error: loadError })}</p>
            <button type="button" className={secondaryButton} onClick={retryLoad}>
              {t('chat.history.retry')}
            </button>
          </div>
        ) : !loaded ? (
          <MessageListSkeleton />
        ) : ids.length === 0 && pending.length === 0 ? (
          <EmptyChannel name={name} isDm={isDm} />
        ) : (
          !hasOlder && <p className="px-4 pt-6 pb-2 text-xs text-muted">{t('chat.history.beginning')}</p>
        )}
        <ol ref={listRef} className="flex flex-col pb-2">
          {rows.map((row) => {
            const key = row.kind === 'message' ? row.message.id : row.pending.nonce;
            let item: ReactNode;
            if (row.kind === 'message') {
              const { message } = row;
              const own = message.authorId === me.id;
              item = (
                <MessageItem
                  message={message}
                  authorName={authorName(usersById.get(message.authorId))}
                  grouped={row.grouped}
                  me={viewer}
                  usersById={usersById}
                  usernames={usernames}
                  isDm={isDm}
                  canEdit={own}
                  canDelete={own || (isAdmin && !isDm)}
                  canReact={canReact}
                  onError={onError}
                />
              );
            } else {
              item = (
                <PendingItem
                  pending={row.pending}
                  authorName={me.displayName}
                  authorAvatarUrl={me.avatarUrl}
                  grouped={row.grouped}
                  usernames={usernames}
                  onError={onError}
                />
              );
            }
            return (
              <Fragment key={key}>
                {row.separator !== null && <DaySeparator label={row.separator} />}
                {item}
              </Fragment>
            );
          })}
        </ol>
      </div>
      {newCount > 0 && !atBottom && (
        <button
          type="button"
          data-testid="jump-to-latest"
          data-count={newCount}
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold whitespace-nowrap text-bg shadow-lg ring-1 ring-black/20 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span>
            {t('chat.history.newMessages', { count: newCount, shown: newCount > 99 ? '99+' : newCount })}
          </span>
          {/* Narrow screens show just the count and the arrow; the name always says what it does. */}
          <span aria-hidden="true" className="hidden sm:inline">
            ·
          </span>
          <span className="sr-only sm:not-sr-only">{t('chat.history.jumpToLatest')}</span>
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
            <path
              d="M8 3v10M3.5 8.5 8 13l4.5-4.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A channel or DM without messages: a friendly welcome instead of an empty list. */
function EmptyChannel({ name, isDm }: { name: string; isDm: boolean }) {
  const copy = emptyChannelCopy(name, isDm);
  return (
    <EmptyState icon={isDm ? 'dm' : 'channels'} title={copy.title}>
      {copy.body}
    </EmptyState>
  );
}

/** "Today", "Yesterday" or a date between two days of history (`data-testid="day-separator"`). */
function DaySeparator({ label }: { label: string }) {
  return (
    <li
      role="separator"
      aria-label={label}
      data-testid="day-separator"
      className="mx-4 mt-4 mb-1 flex items-center gap-3 text-xs font-semibold text-muted"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-white/10" />
      <span aria-hidden="true">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-white/10" />
    </li>
  );
}
