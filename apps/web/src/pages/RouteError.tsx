import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { ApiError } from '../api/client';
import { LogoMark } from '../components/Logo';
import { primaryButton, secondaryButton } from '../components/styles';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n/types';

function describe(error: unknown): { title: MessageKey; detail: MessageKey; notFound?: true } {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return {
      title: 'common.routeError.notFoundTitle',
      detail: 'common.routeError.notFoundDetail',
      notFound: true,
    };
  }
  if (error instanceof ApiError && error.status === 0) {
    return { title: 'common.routeError.unreachableTitle', detail: 'common.routeError.unreachableDetail' };
  }
  return { title: 'common.routeError.genericTitle', detail: 'common.routeError.genericDetail' };
}

/** Route error element: a friendly message instead of React Router's developer screen. */
export function RouteError() {
  const t = useT();
  const error = useRouteError();
  const { title, detail, notFound } = describe(error);
  // The likelier fix is the primary action: going home for a bad address, retrying otherwise.
  const home = (style: string) => (
    <Link to="/" className={`${style} min-h-9`}>
      {t('common.routeError.goHome')}
    </Link>
  );
  const retry = (style: string) => (
    <button
      type="button"
      className={`${style} min-h-9`}
      onClick={() => {
        window.location.reload();
      }}
    >
      {t('common.routeError.tryAgain')}
    </button>
  );
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center rounded-card bg-surface p-6 text-center shadow-card ring-1 ring-line sm:p-8">
        <LogoMark className="size-12" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{t(title)}</h1>
        <p className="mt-2 text-sm text-muted">{t(detail)}</p>
        {/* The primary action comes first, in both visual and tab order. */}
        <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:flex-row">
          {notFound ? (
            <>
              {home(primaryButton)}
              {retry(secondaryButton)}
            </>
          ) : (
            <>
              {retry(primaryButton)}
              {home(secondaryButton)}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** Shown while the first route loaders (the session check) run. */
export function LoadingScreen() {
  const t = useT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6">
      <LogoMark className="size-12 motion-safe:animate-skeleton" />
      <p className="text-sm text-muted" role="status">
        {t('common.loading')}
      </p>
    </main>
  );
}
