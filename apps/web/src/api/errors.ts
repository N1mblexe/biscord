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

const plural = (n: string, one: string, many: string): string => (n === '1' ? one : many);

/**
 * zod 4's default issue messages (the server sends `z.flattenError()` output, so only the message
 * text reaches us) and their plain-English replacements. Anything unmatched (e.g. a custom
 * message from a schema) is shown as it is.
 */
const FRIENDLY: readonly [RegExp, (...groups: string[]) => string][] = [
  [/^Invalid input: expected \w+, received (?:undefined|null|NaN)$/, () => 'Required'],
  [/^Invalid input: expected int, received/, () => 'Must be a whole number'],
  [/^Invalid input: expected (?:number|nan), received/, () => 'Must be a number'],
  [/^Invalid input: expected string, received/, () => 'Must be text'],
  [/^Invalid input: expected /, () => 'Invalid value'],
  [/^Too small: expected string to have >=?1 characters?$/, () => 'Required'],
  [/^Too small: expected string to have >=(\d+) characters?$/, (n) => `Must be at least ${n} characters`],
  [/^Too small: expected string to have >(\d+) characters?$/, (n) => `Must be more than ${n} characters`],
  [/^Too big: expected string to have <=(\d+) characters?$/, (n) => `Must be at most ${n} characters`],
  [/^Too big: expected string to have <(\d+) characters?$/, (n) => `Must be fewer than ${n} characters`],
  [
    /^Too (?:small|big): expected string to have exactly (\d+) characters?$/,
    (n) => `Must be exactly ${n} characters`,
  ],
  [/^Too small: expected (?:number|int|bigint) to be >=(-?[\d.]+)$/, (n) => `Must be at least ${n}`],
  [/^Too small: expected (?:number|int|bigint) to be >(-?[\d.]+)$/, (n) => `Must be greater than ${n}`],
  [/^Too big: expected (?:number|int|bigint) to be <=(-?[\d.]+)$/, (n) => `Must be at most ${n}`],
  [/^Too big: expected (?:number|int|bigint) to be <(-?[\d.]+)$/, (n) => `Must be less than ${n}`],
  [/^Too small: expected array to have >=?1 items?$/, () => 'Required'],
  [
    /^Too small: expected array to have >=(\d+) items?$/,
    (n) => `Must have at least ${n} ${plural(n, 'item', 'items')}`,
  ],
  [
    /^Too big: expected array to have <=(\d+) items?$/,
    (n) => `Must have at most ${n} ${plural(n, 'item', 'items')}`,
  ],
  [/^Invalid UUID$/, () => 'Invalid ID'],
  [/^Invalid email address$/, () => 'Must be a valid email address'],
  [/^Invalid ISO datetime$/, () => 'Must be a valid date and time'],
  [/^Invalid (?:string: must match pattern|input)/, () => 'Invalid format'],
  [
    /^Invalid option: expected one of (.+)$/,
    (list) =>
      `Must be one of: ${list
        .split('|')
        .map((o) => o.replace(/^"|"$/g, ''))
        .join(', ')}`,
  ],
  [/^Unrecognized keys?: /, () => 'Unexpected field'],
];

/** Plain-English text for one VALIDATION message (zod's defaults are written for developers). */
export function friendlyValidationMessage(message: string): string {
  for (const [pattern, text] of FRIENDLY) {
    const match = pattern.exec(message);
    if (match) return text(...match.slice(1));
  }
  return message;
}

/**
 * Per-field messages from a VALIDATION error (`details` = `z.flattenError()` output), in plain
 * English. `overrides` replaces every message of a field with one fixed text, for fields whose
 * rule reads better as a whole (e.g. "Must be a whole number between 1 and 25").
 */
export function fieldErrors(err: unknown, overrides: Partial<Record<string, string>> = {}): FieldErrors {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION' || !isRecord(err.details)) return {};
  const raw = err.details.fieldErrors;
  if (!isRecord(raw)) return {};
  const out: FieldErrors = {};
  for (const [field, messages] of Object.entries(raw)) {
    if (!Array.isArray(messages)) continue;
    const strings = messages.filter((m): m is string => typeof m === 'string');
    if (strings.length === 0) continue;
    const override = overrides[field];
    out[field] = override !== undefined ? [override] : [...new Set(strings.map(friendlyValidationMessage))];
  }
  return out;
}

/**
 * Text for a form's `role="alert"` when some fields show their own VALIDATION messages: `null`
 * when every problem is already shown next to one of `shownFields` (a generic "Invalid request"
 * would only repeat it), otherwise `errorMessage(err, overrides)`.
 */
export function formAlertMessage(
  err: unknown,
  shownFields: readonly string[],
  overrides: Partial<Record<ErrorCode, string>> = {},
): string | null {
  if (err === null || err === undefined) return null;
  const fields = Object.keys(fieldErrors(err));
  const formErrors =
    err instanceof ApiError && isRecord(err.details) && Array.isArray(err.details.formErrors)
      ? err.details.formErrors
      : [];
  if (fields.length > 0 && formErrors.length === 0 && fields.every((f) => shownFields.includes(f))) {
    return null;
  }
  return errorMessage(err, overrides);
}

export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
