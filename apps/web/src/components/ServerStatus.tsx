import { useEffect, useState } from 'react';
import { fetchHealth, type ServerHealth } from '../lib/health';

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

/** The Phase 1 health indicator (`data-testid="server-status"`). */
export function ServerStatus() {
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
    <p className="flex items-center justify-center gap-2 text-sm text-muted">
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[status]}`} />
      <span data-testid="server-status" role="status">
        {LABELS[status]}
      </span>
    </p>
  );
}
