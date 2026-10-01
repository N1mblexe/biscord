import { useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n';
import { connectionLabel, connectionState, type ConnectionState } from '../lib/connectionStatus';
import type { SocketStatus } from '../socket/socket';

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** `navigator.onLine`, kept current. */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

const DOT: Record<ConnectionState, string> = {
  connected: 'bg-success',
  connecting: 'bg-accent motion-safe:animate-skeleton',
  reconnecting: 'bg-accent motion-safe:animate-skeleton',
  offline: 'bg-danger',
};

/**
 * The header's realtime connection indicator (`data-testid="connection-status"`, `data-state`
 * connected / connecting / reconnecting / offline) with a friendly label ("Connected",
 * "Reconnecting…", "Offline"), announced politely. The label is visually hidden below `md` (the dot
 * stays). The raw socket value stays in `data-testid="socket-status"` (`connected` /
 * `disconnected`, docs/plans/phase-2.md), visually hidden and hidden from assistive technology so
 * it isn't read twice.
 */
export function ConnectionStatus({ status }: { status: SocketStatus }) {
  const t = useT();
  const online = useOnline();
  const [everConnected, setEverConnected] = useState(status === 'connected');
  if (status === 'connected' && !everConnected) setEverConnected(true);
  const state = connectionState({ status, online, everConnected });
  const label = connectionLabel(state, t);

  return (
    <span
      data-testid="connection-status"
      data-state={state}
      role="status"
      title={t('a11y.connection.title', { status: label })}
      className="flex items-center gap-2 text-xs text-muted"
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[state]}`} />
      <span className="sr-only md:not-sr-only">{label}</span>
      <span data-testid="socket-status" data-state={state} aria-hidden="true" className="sr-only">
        {status}
      </span>
    </span>
  );
}
