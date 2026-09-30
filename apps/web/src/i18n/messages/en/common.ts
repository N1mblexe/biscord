/** Shared UI words (English, the source of truth; the rules are in `i18n/index.ts`). */
export const common = {
  appName: 'Hearth',
  loading: 'Loading…',
  language: {
    label: 'Language',
    // Each language is always shown in its own name, whatever the UI language.
    en: 'English',
    tr: 'Türkçe',
  },
  memberCount: { one: '{count} member', other: '{count} members' },
} as const;
