import { isLenientNulFailure } from '@hearth/shared';
import { z } from 'zod';
import { AppError } from './errors.js';

function validationError(error: z.ZodError): AppError {
  return new AppError('VALIDATION', 'Invalid request', z.flattenError(error));
}

/** Validates `input` against `schema`; throws `AppError('VALIDATION')` with flattened issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

/**
 * Like `parse`, for requests with lenient fields (CONTRACTS B.4, B.9 rule 1): a failure made only of lenient
 * fields' NUL issues gives `null`, so the caller answers it like a wrong value (`INVALID_CREDENTIALS`,
 * `INVITE_INVALID`, `{valid:false}`). Every other failure is `VALIDATION`.
 */
export function parseLenient<S extends z.ZodType>(schema: S, input: unknown): z.output<S> | null {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  if (isLenientNulFailure(result.error)) return null;
  throw validationError(result.error);
}
