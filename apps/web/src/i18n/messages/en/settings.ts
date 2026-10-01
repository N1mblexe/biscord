/** The Settings page (English, the source of truth). */
export const settings = {
  title: 'Settings',
  profile: {
    heading: 'Profile',
    signedInAs: 'Signed in as <mono>{username}</mono>',
    displayName: 'Display name',
    saved: 'Profile saved.',
    submit: 'Save profile',
  },
  avatar: {
    heading: 'Avatar',
    description: 'A PNG, JPEG or WebP image up to {size}.',
    label: 'Avatar',
    updated: 'Avatar updated.',
    removed: 'Avatar removed.',
    remove: 'Remove avatar',
  },
  password: {
    heading: 'Password',
    description: 'Changing your password signs you out everywhere else.',
    current: 'Current password',
    new: 'New password',
    placeholder: 'at least 10 characters',
    changed: 'Password changed.',
    submit: 'Change password',
    wrongCurrent: 'Your current password is wrong.',
  },
  notifications: {
    heading: 'Notifications',
    description:
      'Get a desktop notification when someone mentions you or sends you a direct message while Hearth is in the background.',
    label: 'Desktop notifications',
    denied: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
    default: 'Notifications were not allowed.',
    unsupported: "This browser doesn't support desktop notifications.",
    /** A desktop notification's title for a channel message (lib/notifications.ts). */
    channelTitle: '{author} in #{channel}',
  },
  language: {
    heading: 'Language',
    description: 'Saved to your account, so it applies on every device you sign in on.',
    updated: 'Language updated.',
  },
} as const;
