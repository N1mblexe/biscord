/**
 * Usernames are stored lower case (login is case-insensitive server-side), so registration sends the
 * trimmed, lower-cased form: "  Alice " registers as "alice" instead of failing validation.
 */
/** The Username rule in words (shared schema: `^[a-z0-9_]{3,32}$`). */
export const USERNAME_RULE = 'Use 3–32 lowercase letters, digits or underscores';

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}
