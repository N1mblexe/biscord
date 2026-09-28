import { Outlet } from 'react-router';

/** Scrollable, centered content column for non-chat pages (settings, admin). */
export function PageLayout() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <Outlet />
      </div>
    </div>
  );
}
