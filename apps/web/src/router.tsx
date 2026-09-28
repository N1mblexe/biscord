import type { Me } from '@hearth/shared';
import { createBrowserRouter, redirect, type LoaderFunctionArgs } from 'react-router';
import { meQuery } from './api/auth';
import { isUnauthenticated } from './api/errors';
import { loginPathFor, safeNext } from './lib/redirects';
import { AdminInvitesPage } from './pages/AdminInvitesPage';
import { AdminLayout } from './pages/AdminLayout';
import { AdminResetCodePage } from './pages/AdminResetCodePage';
import { AppLayout } from './pages/AppLayout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { LoadingScreen, RouteError } from './pages/RouteError';
import { SettingsPage } from './pages/SettingsPage';
import { queryClient } from './queryClient';

/** The signed-in user, or a redirect to `/login?next=<this page>` when there is no session. */
async function requireUser(request: Request): Promise<Me> {
  try {
    // Cached user if we have one (the layout's useQuery revalidates it in the background).
    return await queryClient.query({ ...meQuery, staleTime: 'static' });
  } catch (err) {
    if (isUnauthenticated(err)) {
      const url = new URL(request.url);
      // react-router treats a thrown Response from a loader as a redirect.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect() returns a Response by design
      throw redirect(loginPathFor(url.pathname + url.search));
    }
    throw err;
  }
}

async function userLoader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  return null;
}

async function adminLoader({ request }: LoaderFunctionArgs) {
  const me = await requireUser(request);
  if (me.role !== 'admin') return redirect('/');
  return null;
}

/**
 * Public pages: a signed-in user goes to `/` (the login page honours `?next=`). Any failure to
 * load the session (401, server down) just shows the page.
 */
async function publicLoader({ request }: LoaderFunctionArgs) {
  try {
    await queryClient.query({ ...meQuery, staleTime: 'static' });
  } catch {
    return null;
  }
  const url = new URL(request.url);
  return redirect(url.pathname === '/login' ? safeNext(url.searchParams.get('next')) : '/');
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    HydrateFallback: LoadingScreen,
    children: [
      { path: '/login', loader: publicLoader, Component: LoginPage },
      { path: '/register', loader: publicLoader, Component: RegisterPage },
      { path: '/reset-password', loader: publicLoader, Component: ResetPasswordPage },
      {
        path: '/',
        loader: userLoader,
        Component: AppLayout,
        children: [
          { index: true, Component: HomePage },
          { path: 'settings', Component: SettingsPage },
          {
            path: 'admin',
            loader: adminLoader,
            Component: AdminLayout,
            children: [
              { index: true, loader: () => redirect('/admin/invites') },
              { path: 'invites', Component: AdminInvitesPage },
              { path: 'users/reset', Component: AdminResetCodePage },
            ],
          },
        ],
      },
    ],
  },
]);
