export const LIMITS = {
  maxUsers: 25,
  maxChannels: 50,
  messageMaxChars: 4000,
  attachmentsPerMessage: 10,
  uploadMaxBytes: 25 * 1024 * 1024,
  avatarMaxBytes: 2 * 1024 * 1024,
  distinctReactionsPerMessage: 20,
  messageHistoryPageDefault: 50,
  messageHistoryPageMax: 100,
  inviteMaxUses: 25,
  inviteDefaultExpiresHours: 168,
  inviteMaxExpiresHours: 720,
  resetCodeTtlHours: 24,
  sessionTtlDays: 30,
  livekitTokenTtlSeconds: 600,
  typingExpiryMs: 5000,
  typingThrottleMs: 3000,
  presenceOfflineGraceMs: 3000,
  rateLimits: {
    messageSend: { max: 10, windowMs: 10_000 },
    login: { max: 10, windowMs: 60_000 },
    uploads: { max: 20, windowMs: 60_000 },
  },
} as const;

/** Attachment types served with `Content-Disposition: inline` (and rendered inline by the client). */
export const INLINE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type InlineImageMimeType = (typeof INLINE_IMAGE_MIME_TYPES)[number];

/** Accepted avatar upload types. */
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];
