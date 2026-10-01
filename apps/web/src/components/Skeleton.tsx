import { useT } from '../i18n';

/**
 * Loading placeholders shaped like the content they stand in for. Each list skeleton is one polite
 * `role="status"` with a visually-hidden label, so screen readers hear "Loading messages…" once
 * instead of a pile of empty boxes; the pulse stops under `prefers-reduced-motion`.
 */

/** A single placeholder block; size and shape (including rounding) come from `className`. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`block bg-white/10 ${className}`} />;
}

/** Deterministic, varied widths so the placeholder rows don't look like a table. */
const MESSAGE_ROWS = [
  { lines: ['w-24', 'w-4/5'] },
  { lines: ['w-16', 'w-3/5', 'w-2/5'] },
  { lines: ['w-20', 'w-2/3'] },
  { lines: ['w-28', 'w-1/2'] },
  { lines: ['w-16', 'w-3/4', 'w-1/3'] },
] as const;

/**
 * Stands in for the message list while a channel's first page loads (`data-testid="messages-skeleton"`).
 * Its accessible text is "Loading messages…" (the e2e suite waits for that text to disappear).
 */
export function MessageListSkeleton({ rows = MESSAGE_ROWS.length }: { rows?: number }) {
  const t = useT();
  return (
    <div
      data-testid="messages-skeleton"
      role="status"
      className="flex flex-col gap-5 px-4 py-6 motion-safe:animate-skeleton"
    >
      <span className="sr-only">{t('a11y.loadingMessages')}</span>
      {MESSAGE_ROWS.slice(0, rows).map((row, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
            {row.lines.map((width, j) => (
              <Skeleton key={j} className={`${j === 0 ? 'h-3' : 'h-3.5'} ${width} max-w-full rounded-full`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const CHANNEL_WIDTHS = ['w-24', 'w-32', 'w-20', 'w-28'] as const;

/**
 * Stands in for the sidebar's channel lists while the bootstrap loads
 * (`data-testid="channels-skeleton"`, accessible text "Loading channels…").
 */
export function ChannelListSkeleton() {
  const t = useT();
  return (
    <div
      data-testid="channels-skeleton"
      role="status"
      className="flex flex-col gap-5 motion-safe:animate-skeleton"
    >
      <span className="sr-only">{t('a11y.loadingChannels')}</span>
      {[3, 2].map((count, section) => (
        <div key={section} className="flex flex-col gap-2 px-2">
          <Skeleton className="mb-1 h-2.5 w-20 rounded-full" />
          {CHANNEL_WIDTHS.slice(0, count).map((width, i) => (
            <div key={i} className="flex items-center gap-2 py-1">
              <Skeleton className="size-3.5 shrink-0 rounded" />
              <Skeleton className={`h-3 ${width} rounded-full`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
