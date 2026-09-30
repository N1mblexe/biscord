import type { ReactNode } from 'react';
import { LogoMark } from './Logo';

/**
 * The centered card used by the public pages: the mark, the wordmark (`data-testid="app-title"`,
 * text exactly "Hearth"), the page's title and an optional one-line description, then the form.
 * `footer` sits under a divider (links to the other auth pages, server status).
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 sm:px-6">
      <div className="w-full max-w-sm rounded-card bg-surface p-6 shadow-card ring-1 ring-line sm:p-8">
        <div className="flex flex-col items-center text-center">
          <LogoMark className="size-12" />
          <h1 data-testid="app-title" className="mt-3 text-3xl font-semibold tracking-tight">
            Hearth
          </h1>
          <h2 className="mt-4 text-base font-semibold text-text">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 border-t border-line pt-5">{footer}</div>}
      </div>
      <p className="text-xs text-muted">A private place for friends to hang out.</p>
    </main>
  );
}
