import { createContext, useContext } from 'react';
import type { LoginReason } from '../lib/authNotice';
import type { HearthSocket, SocketStatus } from './socket';

export interface SocketContextValue {
  socket: HearthSocket;
  status: SocketStatus;
  /**
   * Ends the session: disconnects, clears all session state and goes to `/login?reason=<reason>`
   * (with `next=` the current page, except for a manual logout). A no-op once leaving has started.
   */
  endSession: (reason: LoginReason) => void;
  /**
   * Starts leaving for a manual logout (disconnects; the caller clears and navigates once the
   * request settles). `false` when the app is already leaving.
   */
  beginLogout: () => boolean;
}

export const SocketContext = createContext<SocketContextValue | null>(null);

/** The app socket and its status. Only available inside the protected layout. */
export function useSocket(): SocketContextValue {
  const value = useContext(SocketContext);
  if (!value) throw new Error('useSocket must be used inside <SocketProvider>');
  return value;
}
