import { z } from 'zod';

/**
 * CONTRACTS B.9 rule 1: no request string may carry the NUL character. Postgres `text` cannot store it, so
 * one reaching a query would be a 500.
 */
export const NUL_CHAR = '\u0000';

export function hasNul(value: string): boolean {
  return value.includes(NUL_CHAR);
}

const NUL_MESSAGE = 'Must not contain the NUL character';

/**
 * Marks the NUL issue of a lenient field (login, reset, current-password and invite-code fields). The server
 * answers a request whose only issues carry it like a wrong value (`INVALID_CREDENTIALS`, `INVITE_INVALID`,
 * `{valid:false}`), not with `VALIDATION`.
 */
export const LENIENT_NUL_PARAM = 'hearthLenientNul';

/** A strict string field: a NUL is a `VALIDATION` error. */
export function noNul<T extends z.ZodString>(schema: T): T {
  return schema.refine((value) => !hasNul(value), { error: NUL_MESSAGE });
}

/**
 * A lenient field (B.4: any non-empty string up to `max`, optionally trimmed). A NUL is an issue flagged with
 * `LENIENT_NUL_PARAM` (see `isLenientNulFailure`).
 */
export function lenientText(max: number, options: { trim?: boolean } = {}): z.ZodString {
  const base = options.trim === true ? z.string().trim() : z.string();
  return base
    .min(1)
    .max(max)
    .refine((value) => !hasNul(value), { error: NUL_MESSAGE, params: { [LENIENT_NUL_PARAM]: true } });
}

/** True when every issue of `error` is the NUL issue of a lenient field. */
export function isLenientNulFailure(error: z.ZodError): boolean {
  return (
    error.issues.length > 0 &&
    error.issues.every((issue) => issue.code === 'custom' && issue.params?.[LENIENT_NUL_PARAM] === true)
  );
}
