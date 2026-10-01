/** The channel view: history, composer, attachments and typing (English, the source of truth). */
export const chat = {
  edited: '(edited)',
  channel: {
    dropFiles: 'Drop files to attach',
    /** The composer's caption in a DM with a deactivated user. */
    readOnlyDm: 'This conversation is read-only.',
    placeholderChannel: 'Message #{channel}',
    placeholderDm: 'Message {name}',
  },
  composer: {
    /** The message box's (visually hidden) label. */
    label: 'Message',
    attachments: 'Attachments',
    attachFiles: 'Attach files',
    send: 'Send',
    chipUploading: 'Uploading…',
    chipFailed: 'Failed',
    removeFile: 'Remove {filename}',
  },
  message: {
    actions: 'Message actions',
    edit: 'Edit',
    delete: 'Delete',
    confirmDelete: 'Delete this message?',
    editLabel: 'Edit message',
    save: 'Save',
    cancel: 'Cancel',
    editHint: 'Enter to save · Escape to cancel',
    notSent: 'Not sent',
    sending: 'Sending…',
    retry: 'Retry',
    discard: 'Discard',
    tooLong: 'Messages can be at most {max} characters.',
  },
  history: {
    label: 'Chat history',
    loadOlder: 'Load older messages',
    loadError: 'Couldn’t load messages: {error}',
    retry: 'Retry',
    beginning: 'This is the beginning of the conversation.',
    /** `count` picks the form; `shown` is the number on the pill ("99+" above 99). */
    newMessages: { one: '{shown} new message', other: '{shown} new messages' },
    jumpToLatest: 'Jump to latest',
  },
  reactions: {
    label: 'Reactions',
    add: 'Add reaction',
  },
  attachment: {
    /** The download link's text. */
    fileLabel: '{filename} ({size})',
    tooLarge: 'File is too large (max {max}).',
    tooMany: 'You can attach at most {max} files to a message.',
  },
  typing: {
    one: '{a} is typing…',
    two: '{a} and {b} are typing…',
    several: 'Several people are typing…',
  },
  empty: {
    noChannelsTitle: 'No channels yet',
    noChannelsAdmin: 'Create the first text channel so everyone has somewhere to talk.',
    noChannelsMember:
      'An admin hasn’t created any text channels yet. You can still message someone directly from the members list.',
    channelTitle: 'Welcome to #{channel}',
    channelBody: 'Nothing here yet. Be the first to say something!',
    dmTitle: 'This is the start of your conversation with {name}',
    dmBody: 'Say hi — only the two of you can see this.',
    noDmsTitle: 'No conversations yet',
    noDmsBody: 'Start one with the Message button next to someone in the members list.',
  },
  /** The app-wide notice (`app-notice`). */
  notice: {
    channelDeleted: 'This channel was deleted.',
    channelUnavailable: "That channel doesn't exist or you don't have access to it.",
    voiceChannelNoText: 'Voice channels have no text chat. Click one in the sidebar to join it.',
  },
} as const;
