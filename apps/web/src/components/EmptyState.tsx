import type { ReactNode } from 'react';

type Icon = 'channels' | 'chat' | 'dm';

const ICONS: Record<Icon, ReactNode> = {
  channels: (
    <path
      d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  ),
  chat: (
    <path
      d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  ),
  dm: (
    <>
      <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
};

/**
 * A friendly empty state (`data-testid="empty-state"`): an icon in a soft accent circle, a short
 * title, one sentence of help and an optional action. `compact` is the small left-aligned variant
 * for sidebars. Copy lives in lib/emptyStates.ts.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  compact = false,
  headingLevel = 2,
}: {
  icon: Icon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  /** The heading element for `title` (default h2); compact states use a plain paragraph. */
  headingLevel?: 2 | 3;
}) {
  if (compact) {
    return (
      <div data-testid="empty-state" className="flex flex-col gap-0.5 px-2 py-1 text-xs">
        <p className="font-medium text-text">{title}</p>
        {children && <p className="text-muted">{children}</p>}
        {action}
      </div>
    );
  }
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <div
      data-testid="empty-state"
      className="mx-auto flex max-w-sm flex-col items-center gap-3 px-2 py-8 text-center sm:px-4"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/20">
        <svg viewBox="0 0 24 24" className="size-7" fill="none" aria-hidden="true">
          {ICONS[icon]}
        </svg>
      </span>
      <Heading className="text-lg font-semibold tracking-tight text-text">{title}</Heading>
      {children && <p className="text-sm text-muted">{children}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
