import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const userRole = pgEnum('user_role', ['admin', 'member']);
export const channelType = pgEnum('channel_type', ['text', 'voice', 'dm']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  displayName: varchar('display_name', { length: 32 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('member'),
  avatarKey: text('avatar_key'), // storage key; null = default avatar
  createdAt: createdAt(),
  deactivatedAt: ts('deactivated_at'), // soft delete
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), // sha256 hex of cookie token
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 32 }).notNull().unique(),
    grantsRole: userRole('grants_role').notNull().default('member'), // 'admin' only via bootstrap CLI / test reset
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('invites_max_uses_ck', sql`${t.maxUses} between 1 and 25`),
    check('invites_uses_ck', sql`${t.uses} between 0 and ${t.maxUses}`),
  ],
);

export const passwordResetCodes = pgTable(
  'password_reset_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('password_reset_codes_user_id_idx').on(t.userId)],
);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: channelType('type').notNull(),
    name: varchar('name', { length: 32 }), // null iff type = 'dm'
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('channels_name_ck', sql`(${t.type} = 'dm') = (${t.name} is null)`),
    // CONTRACTS B.10 rule 1: text/voice channel names are unique, case-insensitively (names arrive trimmed).
    uniqueIndex('channels_name_lower_uq')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.type} <> 'dm'`),
  ],
);

export const dmChannels = pgTable(
  'dm_channels',
  {
    channelId: uuid('channel_id')
      .primaryKey()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userLowId: uuid('user_low_id')
      .notNull()
      .references(() => users.id),
    userHighId: uuid('user_high_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex('dm_channels_pair_uq').on(t.userLowId, t.userHighId),
    index('dm_channels_user_high_idx').on(t.userHighId),
    check('dm_channels_order_ck', sql`${t.userLowId} < ${t.userHighId}`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    content: text('content').notNull().default(''),
    nonce: varchar('nonce', { length: 64 }), // client-generated, echoed for optimistic dedupe
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
  },
  (t) => [
    index('messages_channel_id_id_idx').on(t.channelId, t.id),
    check('messages_content_len_ck', sql`char_length(${t.content}) <= 4000`),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    messageId: bigint('message_id', { mode: 'number' }).references(() => messages.id, {
      onDelete: 'cascade',
    }),
    storageKey: text('storage_key').notNull().unique(), // relative path under UPLOAD_DIR
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 127 }).notNull(), // sniffed, not client-declared
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('attachments_message_id_idx').on(t.messageId),
    index('attachments_unattached_idx')
      .on(t.createdAt)
      .where(sql`${t.messageId} is null`),
  ],
);

export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    emoji: varchar('emoji', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export const messageMentions = pgTable(
  'message_mentions',
  {
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index('message_mentions_user_channel_idx').on(t.userId, t.channelId, t.messageId),
  ],
);

export const readStates = pgTable(
  'read_states',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }).notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);
