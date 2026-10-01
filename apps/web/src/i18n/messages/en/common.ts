/** Shared UI words (English, the source of truth; the rules are in `i18n/index.ts`). */
export const common = {
  appName: 'Hearth',
  loading: 'Loading…',
  tagline: 'A private place for friends to hang out.',
  cancel: 'Cancel',
  save: 'Save',
  dismissError: 'Dismiss error',
  /** A deactivated user's name everywhere (CONTRACTS B.7b rule 5; e2e matches it). */
  deletedUser: 'Deleted user',
  /** A user missing from the bootstrap. */
  unknownUser: 'Unknown user',
  language: {
    label: 'Language',
    // Each language is always shown in its own name, whatever the UI language.
    en: 'English',
    tr: 'Türkçe',
  },
  memberCount: { one: '{count} member', other: '{count} members' },
  /** `/` when there is no channel to open (HomePage). */
  home: {
    welcome: 'Welcome, {name}',
    pickChannel: 'Pick a channel',
    pickChannelBody:
      'Choose a channel from the sidebar to start chatting, or message someone from the members list.',
    createFirstChannel: 'Create the first channel',
  },
  /** The route error screen (RouteError). */
  routeError: {
    notFoundTitle: 'Page not found',
    notFoundDetail: "There's nothing at this address.",
    unreachableTitle: "Can't reach Hearth",
    unreachableDetail: 'The server is unreachable. Check your connection and try again.',
    genericTitle: 'Something went wrong',
    genericDetail: 'An unexpected error occurred. Please try again.',
    goHome: 'Go home',
    tryAgain: 'Try again',
  },
} as const;
