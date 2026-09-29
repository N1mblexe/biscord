import { redirect, type RouteObject } from 'react-router';

/**
 * The children of `/admin` (the parent's loader is the admin guard). Each page is its own lazy chunk
 * (docs/plans/phase-8.md, "Bundle size"), loaded when the route is first matched.
 */
export const adminRoutes: RouteObject[] = [
  { index: true, loader: () => redirect('/admin/invites') },
  {
    path: 'invites',
    lazy: { Component: async () => (await import('../pages/AdminInvitesPage')).AdminInvitesPage },
  },
  {
    path: 'users',
    lazy: { Component: async () => (await import('../pages/AdminUsersPage')).AdminUsersPage },
  },
  // Phase 2's reset-code page now lives on the users page.
  { path: 'users/reset', loader: () => redirect('/admin/users') },
  {
    path: 'channels',
    lazy: { Component: async () => (await import('../pages/AdminChannelsPage')).AdminChannelsPage },
  },
];
