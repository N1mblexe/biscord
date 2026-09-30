import type { SocketStatus } from '../socket/socket';

/**
 * What the header shows for the realtime connection (`data-state` on the status element):
 * - `connected`: the socket is up;
 * - `connecting`: not connected yet since the page loaded;
 * - `reconnecting`: it was connected and dropped, and Socket.IO is retrying;
 * - `offline`: the browser reports no network, whatever the socket says it is doing.
 */
export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'offline';

export interface ConnectionInputs {
  status: SocketStatus;
  /** `navigator.onLine`: false means the device has no network at all. */
  online: boolean;
  /** The socket has been connected at least once since the page loaded. */
  everConnected: boolean;
}

export function connectionState({ status, online, everConnected }: ConnectionInputs): ConnectionState {
  if (status === 'connected') return 'connected';
  if (!online) return 'offline';
  return everConnected ? 'reconnecting' : 'connecting';
}

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};
