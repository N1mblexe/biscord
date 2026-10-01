import type { ErrorCode, Locale } from '@hearth/shared';
import { getLocale, t } from '../i18n';
import { ApiError } from './client';

export type FieldErrors = Partial<Record<string, string[]>>;

/**
 * Codes whose fixed text is always shown, in every language: the server's wording would mislead or
 * say too much (e.g. which of username and password was wrong).
 */
const FIXED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['INVITE_INVALID', 'INVALID_CREDENTIALS']);

/** The language the server's `message` strings are written in (CONTRACTS B.11 rule 4). */
const SERVER_MESSAGE_LOCALE: Locale = 'en';

/** The text for `code` (`errors.code.<CODE>`) in the current UI language. */
function codeMessage(code: ErrorCode): string {
  return t(`errors.code.${code}`);
}

/**
 * Fixed text shared by every upload's page alert (attachments and avatars): the upload disk-fill
 * guards, CONTRACTS B.7a rule 8. The getters translate whenever the object is read or spread, so
 * `{ ...UPLOAD_ERROR_MESSAGES }` is in the current language.
 */
export const UPLOAD_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  get UPLOAD_QUOTA() {
    return codeMessage('UPLOAD_QUOTA');
  },
  get STORAGE_FULL() {
    return codeMessage('STORAGE_FULL');
  },
};

/**
 * Text for a form's `role="alert"`, in the UI language. `overrides` replaces the default text for a
 * code where the generic wording would mislead (e.g. INVALID_CREDENTIALS on the change-password form).
 *
 * Every `ErrorCode` has a translated text (`errors.code.*`). The server's `message` is English, so an
 * English UI keeps showing it when there is one (it is often more specific: "Channel not found"),
 * except for the fixed codes; any other language shows the text for the code.
 */
export function errorMessage(err: unknown, overrides: Partial<Record<ErrorCode, string>> = {}): string {
  if (!(err instanceof ApiError)) return t('errors.generic');
  const override = overrides[err.code];
  if (override !== undefined) return override;
  // Status 0: the request never reached the server (`apiFetch`, `uploadFile`).
  if (err.status === 0) return t('errors.network');
  if (FIXED_CODES.has(err.code)) return codeMessage(err.code);
  if (getLocale() === SERVER_MESSAGE_LOCALE && err.message) return err.message;
  return codeMessage(err.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * zod 4's default issue messages (the server sends `z.flattenError()` output, so only the message
 * text reaches us) and their plain replacements, translated when used. Anything unmatched (e.g. a
 * custom message from a schema) is shown as it is.
 */
const FRIENDLY: readonly [RegExp, (...groups: string[]) => string][] = [
  [/^Invalid input: expected \w+, received (?:undefined|null|NaN)$/, () => t('errors.validation.required')],
  [/^Invalid input: expected int, received/, () => t('errors.validation.wholeNumber')],
  [/^Invalid input: expected (?:number|nan), received/, () => t('errors.validation.number')],
  [/^Invalid input: expected string, received/, () => t('errors.validation.text')],
  [/^Invalid input: expected /, () => t('errors.validation.invalidValue')],
  [/^Too small: expected string to have >=?1 characters?$/, () => t('errors.validation.required')],
  [/^Too small: expected string to have >=(\d+) characters?$/, (n) => t('errors.validation.minChars', { n })],
  [
    /^Too small: expected string to have >(\d+) characters?$/,
    (n) => t('errors.validation.moreThanChars', { n }),
  ],
  [/^Too big: expected string to have <=(\d+) characters?$/, (n) => t('errors.validation.maxChars', { n })],
  [
    /^Too big: expected string to have <(\d+) characters?$/,
    (n) => t('errors.validation.fewerThanChars', { n }),
  ],
  [
    /^Too (?:small|big): expected string to have exactly (\d+) characters?$/,
    (n) => t('errors.validation.exactChars', { n }),
  ],
  [
    /^Too small: expected (?:number|int|bigint) to be >=(-?[\d.]+)$/,
    (n) => t('errors.validation.min', { n }),
  ],
  [
    /^Too small: expected (?:number|int|bigint) to be >(-?[\d.]+)$/,
    (n) => t('errors.validation.greaterThan', { n }),
  ],
  [/^Too big: expected (?:number|int|bigint) to be <=(-?[\d.]+)$/, (n) => t('errors.validation.max', { n })],
  [
    /^Too big: expected (?:number|int|bigint) to be <(-?[\d.]+)$/,
    (n) => t('errors.validation.lessThan', { n }),
  ],
  [/^Too small: expected array to have >=?1 items?$/, () => t('errors.validation.required')],
  [
    /^Too small: expected array to have >=(\d+) items?$/,
    (count) => t('errors.validation.minItems', { count }),
  ],
  [/^Too big: expected array to have <=(\d+) items?$/, (count) => t('errors.validation.maxItems', { count })],
  [/^Invalid UUID$/, () => t('errors.validation.invalidId')],
  [/^Invalid email address$/, () => t('errors.validation.email')],
  [/^Invalid ISO datetime$/, () => t('errors.validation.dateTime')],
  [/^Invalid (?:string: must match pattern|input)/, () => t('errors.validation.format')],
  [
    /^Invalid option: expected one of (.+)$/,
    (list) =>
      t('errors.validation.oneOf', {
        options: list
          .split('|')
          .map((o) => o.replace(/^"|"$/g, ''))
          .join(', '),
      }),
  ],
  [/^Unrecognized keys?: /, () => t('errors.validation.unexpectedField')],
];

/**
 * Plain text for one VALIDATION message, in the UI language (zod's defaults are written for
 * developers). An unknown message is returned as it is.
 */
export function friendlyValidationMessage(message: string): string {
  for (const [pattern, text] of FRIENDLY) {
    const match = pattern.exec(message);
    if (match) return text(...match.slice(1));
  }
  return message;
}

/**
 * Per-field messages from a VALIDATION error (`details` = `z.flattenError()` output), in plain
 * words in the UI language. `overrides` replaces every message of a field with one fixed text, for
 * fields whose rule reads better as a whole (e.g. "Must be a whole number between 1 and 25").
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
