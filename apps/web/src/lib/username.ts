import { t } from '../i18n/translate';

/** The Username rule in words (shared schema: `^[a-z0-9_]{3,32}$`), in the current language. */
export function usernameRule(): string {
  return t('auth.register.usernameRule');
}

/**
 * Usernames are stored lower case (login is case-insensitive server-side), so registration sends the
 * trimmed, lower-cased form: "  Alice " registers as "alice" instead of failing validation.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}
