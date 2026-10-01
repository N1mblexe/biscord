/** Admin pages: channels, invites and users (English, the source of truth). */
export const admin = {
  /** A role's name as a title ("Admin"); the users table shows `users.role` instead. */
  role: {
    admin: 'Admin',
    member: 'Member',
  },
  nav: {
    label: 'Admin sections',
    invites: 'Invites',
    users: 'Users',
    channels: 'Channels',
  },
  invites: {
    heading: 'Invites',
    maxUses: 'Max uses',
    expiresIn: 'Expires in (hours)',
    /** Each field's whole rule, shown instead of zod's per-check messages. */
    wholeNumberRule: 'Must be a whole number between 1 and {max}',
    created: 'Invite created. Share this link:',
    submit: 'Create invite',
    listHeading: 'All invites',
    loading: 'Loading invites…',
    empty: 'No invites yet.',
    columns: {
      code: 'Code',
      uses: 'Uses',
      expires: 'Expires',
      status: 'Status',
    },
    expired: '(expired)',
    revoked: 'revoked',
    used: 'used',
    revoke: 'Revoke',
  },
  users: {
    heading: 'Users',
    description:
      'Deactivating signs a user out everywhere and removes them from voice; their messages stay, shown as “Deleted user”. A reset code lets a user set a new password on the reset password page: it is shown once, expires after 24 hours, and replaces any older code.',
    resetCodeFor: 'Reset code for <name>{username}</name>:',
    expires: 'Expires {time}',
    loading: 'Loading users…',
    columns: {
      user: 'User',
      role: 'Role',
      status: 'Status',
      presence: 'Presence',
      actions: 'Actions',
    },
    you: '(you)',
    online: 'Online',
    offline: 'Offline',
    /** `data-testid="user-role"` (e2e reads the English text). */
    role: {
      admin: 'admin',
      member: 'member',
    },
    /** `data-testid="user-status"` (e2e reads the English text). */
    status: {
      active: 'active',
      deactivated: 'deactivated',
    },
    /** Button labels (the e2e specs find them by these English names). */
    actions: {
      makeAdmin: 'Make admin',
      removeAdmin: 'Remove admin',
      resetCode: 'Generate reset code',
      deactivate: 'Deactivate',
      reactivate: 'Reactivate',
    },
    deactivateDialog: {
      title: 'Deactivate user',
      body: 'Deactivate <name>{displayName}</name> (@{username})? They are signed out everywhere and removed from voice. Their messages stay, shown as “Deleted user”, and DMs with them become read-only. You can reactivate the account later.',
    },
    errors: {
      lastAdmin: "You can't remove the last admin.",
      userLimit: 'The account limit has been reached.',
      /** Row 31: a 503 may come after the kick notice went out, so it must not claim nothing happened. */
      voiceDisconnect: "LiveKit didn't confirm the disconnect; they may already be disconnected.",
    },
  },
  channels: {
    heading: 'Channels',
    description: 'Up to {max} channels. Deleting a channel deletes all of its messages.',
    name: 'Name',
    type: 'Type',
    types: {
      text: 'Text',
      voice: 'Voice',
    },
    created: 'Created {name}.',
    submit: 'Create channel',
    listHeading: 'All channels',
    loading: 'Loading channels…',
    empty: 'No channels yet.',
    rename: 'Rename',
    newName: 'New name',
    moveUp: 'Move up',
    moveDown: 'Move down',
    delete: 'Delete',
    /** CONFLICT on the create and rename forms. */
    nameTaken: 'A channel with that name already exists.',
    deleteDialog: {
      title: 'Delete {name}?',
      body: 'This permanently deletes the channel and all of its messages. Type <name>{name}</name> to confirm.',
      confirmLabel: 'Type the channel name to confirm',
      submit: 'Delete channel',
    },
  },
} as const;
