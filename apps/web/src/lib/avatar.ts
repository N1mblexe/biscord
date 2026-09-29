import { AVATAR_MIME_TYPES, LIMITS } from '@hearth/shared';
import { errorMessage, UPLOAD_ERROR_MESSAGES } from '../api/errors';

/**
 * Up to two initials for an avatar without an image: the first letters of the first two words of
 * the name (a single word gives one letter), uppercased; `?` for a blank name.
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('');
  return letters.length > 0 ? letters.toLocaleUpperCase() : '?';
}

/** Background colors for initials avatars (dark text on each stays readable). */
export const AVATAR_COLORS = [
  '#f59e0b',
  '#22c55e',
  '#38bdf8',
  '#a78bfa',
  '#f472b6',
  '#fb7185',
  '#2dd4bf',
  '#facc15',
] as const;

/** A stable color for `seed` (a user id): the same user always gets the same color. */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export const AVATAR_TYPE_MESSAGE = 'Avatar must be a PNG, JPEG or WebP image.';
export const AVATAR_SIZE_MESSAGE = 'Avatar must be at most 2 MB.';

const AVATAR_TYPES: ReadonlySet<string> = new Set(AVATAR_MIME_TYPES);

/** Client-side pre-check of an avatar file; the alert text, or `null` when it may be uploaded. */
export function checkAvatarFile(file: { type: string; size: number }): string | null {
  if (!AVATAR_TYPES.has(file.type)) return AVATAR_TYPE_MESSAGE;
  if (file.size > LIMITS.avatarMaxBytes) return AVATAR_SIZE_MESSAGE;
  return null;
}

/** The page alert for a failed avatar change (PUT or DELETE /me/avatar). */
export function avatarUploadError(err: unknown): string {
  return errorMessage(err, {
    ...UPLOAD_ERROR_MESSAGES,
    UNSUPPORTED_MEDIA: AVATAR_TYPE_MESSAGE,
    PAYLOAD_TOO_LARGE: AVATAR_SIZE_MESSAGE,
  });
}
