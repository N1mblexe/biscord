import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { ApiError } from '../api/client';
import { card, linkClass } from '../components/styles';

function describe(error: unknown): { title: string; detail: string } {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return { title: 'Page not found', detail: "There's nothing at this address." };
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
  const { title, detail } = describe(error);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className={`w-full max-w-sm ${card} p-8 text-center`}>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">{detail}</p>
        <div className="mt-6 flex justify-center gap-4 text-sm">
          <Link to="/" className={linkClass}>
            Go home
          </Link>
          <button
            type="button"
            className={linkClass}
            onClick={() => {
              window.location.reload();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}

/** Shown while the first route loaders (the session check) run. */
export function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <p className="text-sm text-muted" role="status">
        Loading…
      </p>
    </main>
  );
}
