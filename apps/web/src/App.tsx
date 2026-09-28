import { useEffect, useState } from 'react';
import { fetchHealth, type ServerHealth } from './lib/health';

type Status = ServerHealth | 'checking';

const LABELS: Record<Status, string> = {
  checking: 'Server: checking…',
  ok: 'Server: ok',
  degraded: 'Server: degraded',
  unreachable: 'Server: unreachable',
};

const DOT: Record<Status, string> = {
  checking: 'bg-muted',
  ok: 'bg-success',
  degraded: 'bg-accent',
  unreachable: 'bg-danger',
};

export function App() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth((input, init) => fetch(input, init), controller.signal).then(setStatus, () => {
      // Aborted on unmount (StrictMode runs effects twice in dev); nothing to update.
    });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-lg ring-1 ring-white/5">
        <h1 data-testid="app-title" className="text-3xl font-semibold tracking-tight">
          Hearth
        </h1>
        <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted">
          <span aria-hidden="true" className={`size-2 rounded-full ${DOT[status]}`} />
          <span data-testid="server-status" role="status">
            {LABELS[status]}
          </span>
        </p>
      </div>
    </main>
  );
}
