/**
 * Where to send a user after login: `next` if it is a same-origin app path, otherwise `/`.
 * Rejects absolute URLs, protocol-relative `//host` and `/\host` (open-redirect guards), and
 * the public auth pages themselves.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next?.startsWith('/')) return '/';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  // Control characters (e.g. an encoded tab or newline) have no place in an app path.
  for (const ch of next) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  const pathname = next.split(/[?#]/, 1)[0] ?? '/';
  if (PUBLIC_PATHS.has(pathname)) return '/';
  return next;
}

const PUBLIC_PATHS = new Set(['/login', '/register', '/reset-password']);

/** The login URL for an unauthenticated visit to `path` (pathname + search). `/` needs no `next`. */
export function loginPathFor(path: string): string {
  const next = safeNext(path);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
