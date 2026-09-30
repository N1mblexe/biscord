import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { ApiError } from '../api/client';
import { LogoMark } from '../components/Logo';
import { primaryButton, secondaryButton } from '../components/styles';

function describe(error: unknown): { title: string; detail: string; notFound?: true } {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return { title: 'Page not found', detail: "There's nothing at this address.", notFound: true };
  }
  if (error instanceof ApiError && error.status === 0) {
    return {
      title: "Can't reach Hearth",
      detail: 'The server is unreachable. Check your connection and try again.',
    };
  }
  return { title: 'Something went wrong', detail: 'An unexpected error occurred. Please try again.' };
}

/** Route error element: a friendly message instead of React Router's developer screen. */
export function RouteError() {
  const error = useRouteError();
  const { title, detail, notFound } = describe(error);
  // The likelier fix is the primary action: going home for a bad address, retrying otherwise.
  const home = (style: string) => (
    <Link to="/" className={`${style} min-h-9`}>
      Go home
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
      Try again
    </button>
  );
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center rounded-card bg-surface p-6 text-center shadow-card ring-1 ring-line sm:p-8">
        <LogoMark className="size-12" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">{detail}</p>
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
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6">
      <LogoMark className="size-12 motion-safe:animate-skeleton" />
      <p className="text-sm text-muted" role="status">
        Loading…
      </p>
    </main>
  );
}
