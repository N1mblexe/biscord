import { describe, expect, it } from 'vitest';
import { accountLocaleToApply } from './useAccountLocale';

describe('accountLocaleToApply', () => {
  it('does nothing until the account is known', () => {
    expect(accountLocaleToApply(undefined, 'en')).toBeNull();
    expect(accountLocaleToApply(undefined, 'tr')).toBeNull();
  });

  it('does nothing when the account language is already shown', () => {
    expect(accountLocaleToApply('en', 'en')).toBeNull();
    expect(accountLocaleToApply('tr', 'tr')).toBeNull();
  });

  it('switches to the account language when it differs (the account wins after login)', () => {
    expect(accountLocaleToApply('tr', 'en')).toBe('tr');
    expect(accountLocaleToApply('en', 'tr')).toBe('en');
  });
});
