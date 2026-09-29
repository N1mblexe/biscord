import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { logout, meQuery } from '../api/auth';
import { isUnauthenticated } from '../api/errors';
import { Avatar } from '../components/Avatar';
import { Sidebar } from '../components/Sidebar';
import { secondaryButton } from '../components/styles';
import { loginPathForReason } from '../lib/authNotice';
import { clearSessionState } from '../lib/session';
import { useNoticeStore } from '../stores/notice';
import { useSocket } from '../socket/context';
import { SocketProvider } from '../socket/SocketProvider';
import { VoiceProvider } from '../voice/VoiceProvider';

/**
 * The protected layout: owns the socket and the voice connection for as long as a signed-in page is
 * shown, so voice survives moving between channels and pages.
 */
export function AppLayout() {
  return (
    <SocketProvider>
      <VoiceProvider>
        <AppShell />
      </VoiceProvider>
    </SocketProvider>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-sm font-medium transition hover:bg-white/5 ${
    isActive ? 'bg-white/5 text-text' : 'text-muted'
  }`;

function AppShell() {
  const { data: me, error } = useQuery(meQuery);
  const { socket, status } = useSocket();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Set while we are leaving on purpose, so the /me 401 that follows logout isn't reported as "session ended".
  const leavingRef = useRef(false);

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      clearSessionState(queryClient);
      void navigate('/login', { replace: true });
    },
  });

  const onLogout = () => {
    leavingRef.current = true;
    // Disconnect first: the server's `session:revoked` for our own logout would otherwise race us.
    socket.disconnect();
    logoutMutation.mutate();
  };

  // A background /me refetch can discover a dead session the socket didn't report.
  useEffect(() => {
    if (leavingRef.current || !isUnauthenticated(error)) return;
    leavingRef.current = true;
    socket.disconnect();
    clearSessionState(queryClient);
    void navigate(loginPathForReason('unauthenticated'), { replace: true });
  }, [error, socket, queryClient, navigate]);

  const connected = status === 'connected';

  return (
    <div className="flex h-screen flex-col">
      <header className="shrink-0 border-b border-white/5 bg-surface">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Hearth
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink to="/settings" className={navLinkClass}>
              Settings
            </NavLink>
            {me?.role === 'admin' && (
              <NavLink to="/admin/invites" className={navLinkClass}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <span className="flex items-center gap-2 text-xs text-muted" title="Realtime connection">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`}
              />
              <span data-testid="socket-status">{status}</span>
            </span>
            <span className="flex items-center gap-2">
              {me && <Avatar userId={me.id} name={me.displayName} avatarUrl={me.avatarUrl} size="sm" />}
              <span data-testid="current-user" className="text-sm font-medium">
                {me?.displayName ?? ''}
              </span>
            </span>
            <button
              type="button"
              className={secondaryButton}
              onClick={onLogout}
              disabled={logoutMutation.isPending}
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <AppNotice />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** The app-wide notice (e.g. "This channel was deleted."), until dismissed or a channel is opened. */
function AppNotice() {
  const notice = useNoticeStore((s) => s.notice);
  const clearNotice = useNoticeStore((s) => s.clearNotice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-accent/20 bg-accent/10 px-4 py-2 text-sm text-accent"
    >
      <p data-testid="app-notice" className="flex-1">
        {notice}
      </p>
      <button type="button" className="text-xs font-medium hover:underline" onClick={clearNotice}>
        Dismiss
      </button>
    </div>
  );
}
