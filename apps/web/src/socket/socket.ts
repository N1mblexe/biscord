import {
  ConnectErrorData,
  SessionRevokedPayload,
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@hearth/shared';
import { io, type Socket } from 'socket.io-client';
import type { LoginReason } from '../lib/authNotice';

export type HearthSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type SocketStatus = 'connected' | 'disconnected';

/**
 * A same-origin socket (Vite proxies `/socket.io` with `ws: true` in dev; Caddy in production).
 * WebSocket only: skips the long-polling handshake, so the session cookie is checked once on upgrade.
 * Created disconnected; the protected layout connects it.
 */
export function createSocket(): HearthSocket {
  return io({
    path: SOCKET_PATH,
    withCredentials: true,
    autoConnect: false,
    transports: ['websocket'],
  });
}

/**
 * `unauthenticated` when the handshake was refused because the session is missing or revoked
 * (`err.data.code === 'UNAUTHENTICATED'`); `null` for anything else (server down, network), which
 * socket.io retries on its own.
 */
export function connectErrorReason(err: { data?: unknown }): LoginReason | null {
  const parsed = ConnectErrorData.safeParse(err.data);
  return parsed.success && parsed.data.code === 'UNAUTHENTICATED' ? 'unauthenticated' : null;
}

/** The reason from a `session:revoked` payload; a malformed payload still means "log in again". */
export function revokedReason(payload: unknown): LoginReason {
  const parsed = SessionRevokedPayload.safeParse(payload);
  return parsed.success ? parsed.data.reason : 'unauthenticated';
}
