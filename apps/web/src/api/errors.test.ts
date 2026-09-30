import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { fieldErrors, formAlertMessage, friendlyValidationMessage } from './errors';

const validation = (fieldErrors: Record<string, string[]>, formErrors: string[] = []) =>
  new ApiError(400, 'VALIDATION', 'Invalid request', { formErrors, fieldErrors });

describe('friendlyValidationMessage', () => {
  it("replaces zod 4's default messages with plain English", () => {
    const cases: [string, string][] = [
      ['Invalid input: expected string, received undefined', 'Required'],
      ['Invalid input: expected number, received null', 'Required'],
      ['Too small: expected string to have >=1 characters', 'Required'],
      ['Too small: expected string to have >=10 characters', 'Must be at least 10 characters'],
      ['Too big: expected string to have <=32 characters', 'Must be at most 32 characters'],
      ['Too small: expected string to have exactly 3 characters', 'Must be exactly 3 characters'],
      ['Too big: expected number to be <=25', 'Must be at most 25'],
      ['Too small: expected number to be >=1', 'Must be at least 1'],
      ['Invalid input: expected int, received number', 'Must be a whole number'],
      ['Invalid input: expected number, received string', 'Must be a number'],
      ['Too big: expected array to have <=10 items', 'Must have at most 10 items'],
      ['Too small: expected array to have >=1 items', 'Required'],
      ['Invalid string: must match pattern /^[a-z0-9_]{3,32}$/', 'Invalid format'],
      ['Invalid UUID', 'Invalid ID'],
      ['Invalid option: expected one of "text"|"voice"', 'Must be one of: text, voice'],
      ['Unrecognized key: "b"', 'Unexpected field'],
    ];
    for (const [raw, friendly] of cases) expect(friendlyValidationMessage(raw)).toBe(friendly);
  });

  it('keeps custom (already friendly) messages', () => {
    expect(friendlyValidationMessage('ids must be unique')).toBe('ids must be unique');
  });
});

describe('fieldErrors', () => {
  it('maps and de-duplicates each field', () => {
    const err = validation({
      name: [
        'Too small: expected string to have >=1 characters',
        'Invalid input: expected string, received undefined',
      ],
      displayName: ['Too big: expected string to have <=32 characters'],
    });
    expect(fieldErrors(err)).toEqual({ name: ['Required'], displayName: ['Must be at most 32 characters'] });
  });

  it('uses a per-field override for rules that read better as a whole', () => {
    const err = validation({ maxUses: ['Too big: expected number to be <=25'] });
    expect(fieldErrors(err, { maxUses: 'Must be a whole number between 1 and 25' })).toEqual({
      maxUses: ['Must be a whole number between 1 and 25'],
    });
  });

  it('is empty for anything but a VALIDATION error', () => {
    expect(fieldErrors(new ApiError(409, 'CONFLICT', 'Taken'))).toEqual({});
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});

describe('formAlertMessage', () => {
  it('shows no generic alert when every problem is shown next to its field', () => {
    const err = validation({ name: ['Too small: expected string to have >=1 characters'] });
    expect(formAlertMessage(err, ['name'])).toBeNull();
  });

  it('still alerts for a field the form does not show, or a form-level error', () => {
    expect(formAlertMessage(validation({ other: ['Invalid UUID'] }), ['name'])).toBe('Invalid request');
    expect(formAlertMessage(validation({ name: ['Invalid UUID'] }, ['Bad']), ['name'])).toBe(
      'Invalid request',
    );
  });

  it('falls back to errorMessage for other errors and to null without one', () => {
    expect(formAlertMessage(new ApiError(401, 'INVALID_CREDENTIALS', 'x'), ['username'])).toBe(
      'Wrong username or password.',
    );
    expect(formAlertMessage(null, ['name'])).toBeNull();
  });
});
