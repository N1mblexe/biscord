import type { ReactNode } from 'react';
import { card } from './styles';

/** The centered card used by the public pages, in the Phase 1 style. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className={`w-full max-w-sm ${card} p-8`}>
        <h1 data-testid="app-title" className="text-center text-3xl font-semibold tracking-tight">
          Hearth
        </h1>
        <h2 className="mt-2 text-center text-sm text-muted">{title}</h2>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
