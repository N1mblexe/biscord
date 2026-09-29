import type { ErrorCode } from '@hearth/shared';
import { ApiError } from './client';

export type FieldErrors = Partial<Record<string, string[]>>;

/** Fixed user-facing text for some codes; everything else shows the server's message. */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  INVITE_INVALID: 'This invite is invalid, expired, or already used.',
  INVALID_CREDENTIALS: 'Wrong username or password.',
};

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/** CONTRACTS B.7a rule 8: the upload disk-fill guards. */
export const UPLOAD_QUOTA_MESSAGE = 'Too many files waiting to be sent. Send or remove some first.';
export const STORAGE_FULL_MESSAGE = 'The server is out of storage space. Tell an admin.';

/** Fixed text shared by every upload's page alert (attachments and avatars). */
export const UPLOAD_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UPLOAD_QUOTA: UPLOAD_QUOTA_MESSAGE,
  STORAGE_FULL: STORAGE_FULL_MESSAGE,
};

/**
 * Text for a form's `role="alert"`. `overrides` replaces the default text for a code where the
 * generic wording would mislead (e.g. INVALID_CREDENTIALS on the change-password form).
 */
export function errorMessage(err: unknown, overrides: Partial<Record<ErrorCode, string>> = {}): string {
  if (err instanceof ApiError) {
    return overrides[err.code] ?? DEFAULT_MESSAGES[err.code] ?? (err.message || FALLBACK_MESSAGE);
  }
  return FALLBACK_MESSAGE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Per-field messages from a VALIDATION error (`details` = `z.flattenError()` output). */
export function fieldErrors(err: unknown): FieldErrors {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION' || !isRecord(err.details)) return {};
  const raw = err.details.fieldErrors;
  if (!isRecord(raw)) return {};
  const out: FieldErrors = {};
  for (const [field, messages] of Object.entries(raw)) {
    if (Array.isArray(messages)) {
      const strings = messages.filter((m): m is string => typeof m === 'string');
      if (strings.length > 0) out[field] = strings;
    }
  }
  return out;
}

export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
