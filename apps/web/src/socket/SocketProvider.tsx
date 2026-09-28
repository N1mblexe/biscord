import { UserUpdatedPayload } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { usersQuery } from '../api/admin';
import { meQuery } from '../api/auth';
import { loginPathForReason, type LoginReason } from '../lib/authNotice';
import { SocketContext } from './context';
import { connectErrorReason, createSocket, revokedReason, type SocketStatus } from './socket';

/**
 * Owns the app socket for the lifetime of the protected layout: connects on mount, disconnects on
 * unmount. A revoked or rejected session clears all cached server state and sends the user to
 * `/login?reason=<reason>`.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket] = useState(createSocket);
  const [status, setStatus] = useState<SocketStatus>('disconnected');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    const endSession = (reason: LoginReason) => {
      socket.disconnect();
      // Clear before navigating so the /login loader doesn't find a cached user and bounce back.
      queryClient.clear();
      void navigate(loginPathForReason(reason), { replace: true });
    };

    const onConnect = () => {
      setStatus('connected');
    };
    const onDisconnect = () => {
      setStatus('disconnected');
    };
    const onConnectError = (err: { data?: unknown }) => {
      setStatus('disconnected');
      const reason = connectErrorReason(err);
      if (reason) endSession(reason);
    };
    const onSessionRevoked = (payload: unknown) => {
      endSession(revokedReason(payload));
    };
    const onUserUpdated = (payload: unknown) => {
      const parsed = UserUpdatedPayload.safeParse(payload);
      if (!parsed.success) return;
      const { user } = parsed.data;
      queryClient.setQueryData(meQuery.queryKey, (me) => (me?.id === user.id ? { ...me, ...user } : me));
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('session:revoked', onSessionRevoked);
    socket.on('user:updated', onUserUpdated);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('session:revoked', onSessionRevoked);
      socket.off('user:updated', onUserUpdated);
      socket.disconnect();
    };
  }, [socket, queryClient, navigate]);

  const value = useMemo(() => ({ socket, status }), [socket, status]);
  return <SocketContext value={value}>{children}</SocketContext>;
}
