import { ErrorCode } from '@hearth/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n/store';
import { ApiError } from './client';
import {
  errorMessage,
  fieldErrors,
  formAlertMessage,
  friendlyValidationMessage,
  UPLOAD_ERROR_MESSAGES,
} from './errors';

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

describe('errorMessage', () => {
  afterEach(() => {
    useLocaleStore.setState({ locale: 'en' });
  });

  it('keeps the server message in English, except for the fixed codes', () => {
    expect(errorMessage(new ApiError(404, 'NOT_FOUND', 'Channel not found'))).toBe('Channel not found');
    expect(errorMessage(new ApiError(404, 'NOT_FOUND', ''))).toBe('Not found. It may have been deleted.');
    expect(errorMessage(new ApiError(400, 'INVITE_INVALID', 'x'))).toBe(
      'This invite is invalid, expired, or already used.',
    );
    expect(errorMessage(new ApiError(0, 'INTERNAL', 'x'))).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
    expect(errorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });

  it('maps every code to Turkish text and ignores the English server message', () => {
    useLocaleStore.setState({ locale: 'tr' });
    expect(errorMessage(new ApiError(404, 'NOT_FOUND', 'Channel not found'))).toBe(
      'Bulunamadı. Silinmiş olabilir.',
    );
    expect(errorMessage(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))).toBe(
      'Kullanıcı adı ya da şifre yanlış.',
    );
    expect(errorMessage(new ApiError(0, 'INTERNAL', 'x'))).toBe(
      'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.',
    );
    expect(errorMessage(new ApiError(409, 'CONFLICT', 'x'), { CONFLICT: 'Ad alınmış.' })).toBe('Ad alınmış.');
    expect(errorMessage(new Error('boom'))).toBe('Bir şeyler ters gitti. Lütfen tekrar deneyin.');
    for (const code of ErrorCode.options) {
      expect(errorMessage(new ApiError(400, code, 'English')), code).not.toBe('English');
    }
  });

  it('translates the upload texts whenever they are read', () => {
    expect(UPLOAD_ERROR_MESSAGES.STORAGE_FULL).toBe('The server is out of storage space. Tell an admin.');
    useLocaleStore.setState({ locale: 'tr' });
    expect({ ...UPLOAD_ERROR_MESSAGES }.STORAGE_FULL).toBe(
      'Sunucuda depolama alanı kalmadı. Bir yöneticiye haber verin.',
    );
  });

  it('gives Turkish validation messages', () => {
    useLocaleStore.setState({ locale: 'tr' });
    expect(friendlyValidationMessage('Invalid input: expected string, received undefined')).toBe('Zorunlu');
    expect(friendlyValidationMessage('Too big: expected string to have <=32 characters')).toBe(
      'En fazla 32 karakter olmalı',
    );
    expect(friendlyValidationMessage('Too big: expected array to have <=10 items')).toBe(
      'En fazla 10 öğe olmalı',
    );
    expect(friendlyValidationMessage('Invalid option: expected one of "text"|"voice"')).toBe(
      'Şunlardan biri olmalı: text, voice',
    );
  });

  it('keeps the English item plural', () => {
    expect(friendlyValidationMessage('Too small: expected array to have >=2 items')).toBe(
      'Must have at least 2 items',
    );
    expect(friendlyValidationMessage('Too big: expected array to have <=1 items')).toBe(
      'Must have at most 1 item',
    );
  });
});
