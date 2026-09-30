import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { logout, meQuery } from '../api/auth';
import { isUnauthenticated } from '../api/errors';
import { Avatar } from '../components/Avatar';
import { DrawerBackdrop, drawerIconButton } from '../components/Drawer';
import { PageAlert } from '../components/forms';
import { Sidebar } from '../components/Sidebar';
import { secondaryButton } from '../components/styles';
import { loginPathForReason } from '../lib/authNotice';
import { clearSessionState } from '../lib/session';
import { useDrawerStore } from '../stores/drawers';
import { useNoticeStore } from '../stores/notice';
import { usePageAlertStore } from '../stores/pageAlert';
import { useSocket } from '../socket/context';
import { SocketProvider } from '../socket/SocketProvider';
import { VideoStageSlot, VoiceProvider } from '../voice/VoiceProvider';

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
  const { status, endSession, beginLogout } = useSocket();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      clearSessionState(queryClient);
      void navigate(loginPathForReason('logout'), { replace: true });
    },
  });

  const onLogout = () => {
    // Shares the socket's exit, so the /me 401 that follows logout (or a racing `session:revoked`)
    // can't send us to "session ended" instead.
    if (beginLogout()) logoutMutation.mutate();
  };

  // A background /me refetch can discover a dead session the socket didn't report. Ignored once the
  // app is already leaving (endSession keeps the first reason).
  useEffect(() => {
    if (isUnauthenticated(error)) endSession('unauthenticated');
  }, [error, endSession]);

  // A camera or screen share error belongs to the page it happened on: gone once we navigate. So
  // does an open drawer (a channel link, **Message**, Settings… were tapped in it).
  const { pathname } = useLocation();
  useEffect(() => {
    usePageAlertStore.getState().clear();
    useDrawerStore.getState().close();
  }, [pathname]);

  const connected = status === 'connected';

  // Below `md` the header is one row: the drawer buttons, and the status and user name as
  // visually hidden text next to the dot and avatar. From `md` up it is unchanged.
  return (
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b border-white/5 bg-surface">
        <div className="flex items-center gap-x-2 px-2 py-2 md:flex-wrap md:gap-x-4 md:gap-y-2 md:px-4 md:py-3">
          <OpenNavigationButton />
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Hearth
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1 max-md:hidden">
            <NavLink to="/settings" className={navLinkClass}>
              Settings
            </NavLink>
            {me?.role === 'admin' && (
              <NavLink to="/admin/invites" className={navLinkClass}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-3 md:gap-4">
            <span className="flex items-center gap-2 text-xs text-muted" title="Realtime connection">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`}
              />
              <span data-testid="socket-status" className="max-md:sr-only">
                {status}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              {me && <Avatar userId={me.id} name={me.displayName} avatarUrl={me.avatarUrl} size="sm" />}
              <span data-testid="current-user" className="truncate text-sm font-medium max-md:sr-only">
                {me?.displayName ?? ''}
              </span>
            </span>
            <button
              type="button"
              className={`${secondaryButton} shrink-0 whitespace-nowrap`}
              onClick={onLogout}
              disabled={logoutMutation.isPending}
            >
              Log out
            </button>
            <MembersButton />
          </div>
        </div>
      </header>
      <DrawerBackdrop />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <AppNotice />
          <FallbackAlert />
          <VideoStageSlot />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Header button (phones only) that opens the sidebar drawer (`#app-sidebar`). */
function OpenNavigationButton() {
  const open = useDrawerStore((s) => s.open === 'nav');
  const toggle = useDrawerStore((s) => s.toggle);
  return (
    <button
      type="button"
      aria-label="Open navigation"
      aria-expanded={open}
      aria-controls="app-sidebar"
      className={`${drawerIconButton} md:hidden`}
      onClick={() => {
        toggle('nav');
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-5" fill="none">
        <path
          d="M2.5 4h11M2.5 8h11M2.5 12h11"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/**
 * Header button (phones only, while the page has a members panel) that opens the members drawer
 * (`#members-panel`), where **Message** starts a DM.
 */
function MembersButton() {
  const available = useDrawerStore((s) => s.membersHosts > 0);
  const open = useDrawerStore((s) => s.open === 'members');
  const toggle = useDrawerStore((s) => s.toggle);
  if (!available) return null;
  return (
    <button
      type="button"
      aria-label="Members"
      title="Members"
      aria-expanded={open}
      aria-controls="members-panel"
      className={`${drawerIconButton} md:hidden`}
      onClick={() => {
        toggle('members');
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="none">
        <circle cx="7.5" cy="7" r="2.75" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M2.5 16c.5-2.6 2.5-4 5-4s4.5 1.4 5 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M13 4.6a2.6 2.6 0 0 1 0 4.8M14.5 12.3c1.6.5 2.7 1.8 3 3.7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/**
 * Camera and screen share errors while no page shows them itself: every page in this layout does,
 * through its single alert slot (components/usePageAlert.ts), so this only covers a moment without a
 * mounted page. Never a second `role="alert"`.
 */
function FallbackAlert() {
  const message = usePageAlertStore((s) => (s.hosts === 0 ? (s.alert?.message ?? null) : null));
  const clear = usePageAlertStore((s) => s.clear);
  if (message === null) return null;
  return (
    <div className="shrink-0 px-4 pt-3">
      <PageAlert message={message} onDismiss={clear} />
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
