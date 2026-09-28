import { z } from 'zod';
import { AppError } from './errors.js';

/** Validates `input` against `schema`; throws `AppError('VALIDATION')` with flattened issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('VALIDATION', 'Invalid request', z.flattenError(result.error));
  }
  return result.data;
}
