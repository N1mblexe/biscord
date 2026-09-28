/**
 * Usernames are stored lower case (login is case-insensitive server-side), so registration sends the
 * trimmed, lower-cased form: "  Alice " registers as "alice" instead of failing validation.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}
