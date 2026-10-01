/**
 * The app shell (header, navigation drawer, sidebar, members panel, connection and server status,
 * avatars) and assistive-technology text: aria-labels, titles and live regions (English, the source
 * of truth).
 */
export const a11y = {
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  /** The navigation drawer's dialog name (phones). */
  navigation: 'Navigation',
  closeMembers: 'Close members',
  /** Landmark names. */
  mainNav: 'Main',
  channelsNav: 'Channels',
  online: 'Online',
  offline: 'Offline',
  loadingMessages: 'Loading messages…',
  loadingChannels: 'Loading channels…',
  layout: {
    settings: 'Settings',
    admin: 'Admin',
    logOut: 'Log out',
    dismiss: 'Dismiss',
    members: 'Members',
    /** The members panel's button that opens a DM. */
    message: 'Message',
    textChannels: 'Text channels',
    voiceChannels: 'Voice channels',
    directMessages: 'Direct messages',
    noTextChannels: 'No text channels yet.',
    noVoiceChannels: 'No voice channels yet.',
    mentions: { one: '{count} mention', other: '{count} mentions' },
  },
  /** The header's realtime connection indicator. */
  connection: {
    connected: 'Connected',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    offline: 'Offline',
    title: 'Realtime connection: {status}',
  },
  /** The login page's health indicator (e2e matches "Server: ok"). */
  server: {
    checking: 'Server: checking…',
    ok: 'Server: ok',
    degraded: 'Server: degraded',
    unreachable: 'Server: unreachable',
  },
  avatar: {
    invalidType: 'Avatar must be a PNG, JPEG or WebP image.',
    /** `{size}` is a formatted size, e.g. "2 MB". */
    tooLarge: 'Avatar must be at most {size}.',
  },
} as const;
