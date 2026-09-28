import { createContext, useContext } from 'react';
import type { HearthSocket, SocketStatus } from './socket';

export interface SocketContextValue {
  socket: HearthSocket;
  status: SocketStatus;
}

export const SocketContext = createContext<SocketContextValue | null>(null);

/** The app socket and its status. Only available inside the protected layout. */
export function useSocket(): SocketContextValue {
  const value = useContext(SocketContext);
  if (!value) throw new Error('useSocket must be used inside <SocketProvider>');
  return value;
}
