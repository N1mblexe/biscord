import { UserUpdatedPayload } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { usersQuery } from '../api/admin';
import { meQuery } from '../api/auth';
import { loginPathForReason, SessionExit, type LoginReason } from '../lib/authNotice';
import { installEventLog } from '../lib/eventLog';
import { clearSessionState } from '../lib/session';
import { registerChatEvents } from './chatEvents';
import { SocketContext } from './context';
import { registerVoiceEvents } from './voiceEvents';
import { connectErrorReason, createSocket, revokedReason, type SocketStatus } from './socket';

/**
 * Owns the app socket for the lifetime of the protected layout: connects on mount, disconnects on
 * unmount. A revoked or rejected session clears all cached server state and sends the user to
 * `/login?reason=<reason>`. Chat events and reconnect catch-up are wired in `chatEvents.ts`.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket] = useState(createSocket);
  const [status, setStatus] = useState<SocketStatus>('disconnected');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // One per signed-in stay: the protected layout unmounts on the way to /login.
  const [exit] = useState(() => new SessionExit());

  const endSession = useCallback(
    (reason: LoginReason) => {
      if (!exit.begin()) return;
      socket.disconnect();
      // Clear before navigating so the /login loader doesn't find a cached user and bounce back.
      clearSessionState(queryClient);
      const from = window.location.pathname + window.location.search;
      void navigate(loginPathForReason(reason, from), { replace: true });
    },
    [exit, socket, queryClient, navigate],
  );

  const beginLogout = useCallback(() => {
    if (!exit.begin()) return false;
    // Disconnect first: the server's `session:revoked` for our own logout would otherwise race us.
    socket.disconnect();
    return true;
  }, [exit, socket]);

  useEffect(() => {
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
    const uninstallEventLog = installEventLog(socket);
    const unregisterChat = registerChatEvents(socket, {
      queryClient,
      navigate: (to) => {
        void navigate(to);
      },
    });
    const unregisterVoice = registerVoiceEvents(socket);
    socket.connect();

    return () => {
      uninstallEventLog();
      unregisterChat();
      unregisterVoice();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('session:revoked', onSessionRevoked);
      socket.off('user:updated', onUserUpdated);
      socket.disconnect();
    };
  }, [socket, queryClient, navigate, endSession]);

  const value = useMemo(
    () => ({ socket, status, endSession, beginLogout }),
    [socket, status, endSession, beginLogout],
  );
  return <SocketContext value={value}>{children}</SocketContext>;
}
