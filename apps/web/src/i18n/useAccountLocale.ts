import type { Locale } from '@hearth/shared';
import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import { meQuery } from '../api/auth';
import { getLocale, useLocaleStore } from './store';

/**
 * The language to switch to for the account's `locale` (CONTRACTS B.11 rule 3: after login the
 * account wins): `null` while there is no account data, or when it is already the one shown.
 */
export function accountLocaleToApply(accountLocale: Locale | undefined, current: Locale): Locale | null {
  return accountLocale !== undefined && accountLocale !== current ? accountLocale : null;
}

/**
 * Applies the signed-in account's language whenever it changes (login, a `/me` refetch that picks up
 * a change made in another tab). It runs only when `me.locale` changes, not when the UI language
 * does, so an optimistic switch in Settings is never undone while its PATCH is in flight.
 * `setLocale` also stores the choice in this browser, so the language survives logging out.
 */
export function useAccountLocale(): void {
  const accountLocale = useQuery(meQuery).data?.locale;
  useLayoutEffect(() => {
    const next = accountLocaleToApply(accountLocale, getLocale());
    if (next !== null) useLocaleStore.getState().setLocale(next);
  }, [accountLocale]);
}
