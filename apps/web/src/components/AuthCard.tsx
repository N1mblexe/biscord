import type { ReactNode } from 'react';
import { isLocale } from '../i18n/detect';
import { useLocale, useT } from '../i18n/useT';
import { LanguageOptions } from './forms';
import { LogoMark } from './Logo';

/**
 * The centered card used by the public pages: the mark, the wordmark (`data-testid="app-title"`,
 * text exactly "Hearth"), the page's title and an optional one-line description, then the form.
 * `footer` sits under a divider (links to the other auth pages, server status), followed by the
 * language picker.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 sm:px-6">
      <div className="w-full max-w-sm rounded-card bg-surface p-6 shadow-card ring-1 ring-line sm:p-8">
        <div className="flex flex-col items-center text-center">
          <LogoMark className="size-12" />
          <h1 data-testid="app-title" className="mt-3 text-3xl font-semibold tracking-tight">
            {t('common.appName')}
          </h1>
          <h2 className="mt-4 text-base font-semibold text-text">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        <div className="mt-6">{children}</div>
        <div className="mt-6 flex flex-col gap-4 border-t border-line pt-5">
          {footer}
          <LanguagePicker />
        </div>
      </div>
      <p className="text-xs text-muted">{t('common.tagline')}</p>
    </main>
  );
}

/**
 * The compact **Language** select (CONTRACTS B.11): switches at once and remembers the choice in
 * this browser (`hearth:language`); after login the account's language wins.
 */
function LanguagePicker() {
  const t = useT();
  const [locale, setLocale] = useLocale();
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted">
      <label htmlFor="auth-language">{t('common.language.label')}</label>
      <select
        id="auth-language"
        data-testid="language-select"
        className="rounded-md bg-bg px-2 py-1 text-xs text-text ring-1 ring-white/10 focus:ring-2 focus:ring-accent focus:outline-none"
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) setLocale(next);
        }}
      >
        <LanguageOptions />
      </select>
    </div>
  );
}
