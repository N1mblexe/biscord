import { NavLink, Outlet } from 'react-router';
import { useT } from '../i18n/useT';

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium transition hover:bg-white/5 ${
    isActive ? 'bg-surface-raised text-text' : 'text-muted'
  }`;

/** Admin section: sub-navigation plus the active admin page. Access is enforced by the route loader. */
export function AdminLayout() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label={t('admin.nav.label')} className="flex flex-wrap gap-1">
        <NavLink to="/admin/invites" className={tabClass}>
          {t('admin.nav.invites')}
        </NavLink>
        <NavLink to="/admin/users" className={tabClass}>
          {t('admin.nav.users')}
        </NavLink>
        <NavLink to="/admin/channels" className={tabClass}>
          {t('admin.nav.channels')}
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
