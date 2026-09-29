import { NavLink, Outlet } from 'react-router';

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium transition hover:bg-white/5 ${
    isActive ? 'bg-surface-raised text-text' : 'text-muted'
  }`;

/** Admin section: sub-navigation plus the active admin page. Access is enforced by the route loader. */
export function AdminLayout() {
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Admin sections" className="flex gap-1">
        <NavLink to="/admin/invites" className={tabClass}>
          Invites
        </NavLink>
        <NavLink to="/admin/users" className={tabClass}>
          Users
        </NavLink>
        <NavLink to="/admin/channels" className={tabClass}>
          Channels
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
