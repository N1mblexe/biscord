# Hearth — Contracts

These contracts are **binding**. Code in `packages/shared`, `apps/server` and `apps/web` must match them.
Any change to a contract edits this file **in the same commit** as the code change, and schema changes go
through a new Drizzle migration.

Sections: B.1 database schema · B.2 shared DTOs · B.3 error format · B.4 REST · B.5 Socket.IO ·
B.6 LiveKit · B.7 lifecycle rules · B.8 runtime topology (ports, URLs, env).

### B.1 Drizzle schema (`apps/server/src/db/schema.ts`)

```ts
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
  (t) => [check('channels_name_ck', sql`(${t.type} = 'dm') = (${t.name} is null)`)],
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
```

Voice membership and presence are **in memory only** (they are rebuilt from LiveKit and socket connections).

### B.2 Shared primitives and DTOs (`packages/shared/src/schemas/*`)

```ts
Uuid = z.uuid();  MessageId = z.string().regex(/^[1-9]\d{0,15}$/);   // bigint ids travel as strings
Username = z.string().regex(/^[a-z0-9_]{3,32}$/);  DisplayName = z.string().trim().min(1).max(32);
Password = z.string().min(10).max(128);  ChannelName = z.string().trim().min(1).max(32);
Emoji = z.string().max(64).regex(/^\p{RGI_Emoji}$/v);  IsoDate = z.iso.datetime({ offset: true });
Role = z.enum(['admin','member']);

PublicUser  = { id, username, displayName, avatarUrl: string|null, role, deactivated: boolean }
Me          = PublicUser & { createdAt }
Channel     = { id, type: 'text'|'voice', name, position }
DmChannel   = { id, type: 'dm', otherUserId }
Attachment  = { id, filename, mimeType, sizeBytes, url, inline: boolean }    // url = /api/attachments/:id/:filename
Reaction    = { emoji: ReactionEmoji, userIds: Uuid[] }                         // count = userIds.length
// ReactionEmoji (response side: Reaction, reaction:added/removed) = any non-empty string ≤ 64 chars without NUL,
// so a client whose Unicode tables are older than the server's doesn't reject a whole page; requests use Emoji.
Message     = { id: MessageId, channelId, authorId, content, createdAt, editedAt: IsoDate|null,
                attachments: Attachment[], reactions: Reaction[], mentionUserIds: Uuid[], nonce: string|null }
ReadState   = { channelId, lastReadMessageId: MessageId|'0', unread: boolean, mentionCount: number }
Invite      = { id, code, maxUses, uses, expiresAt, revokedAt: IsoDate|null, createdAt, createdBy: Uuid|null }
VoiceParticipant = { userId, joinedAt, selfMute, selfDeaf, camera, screen }
```

### B.3 Error format (REST and sockets)

```ts
ErrorCode = z.enum(['VALIDATION','UNAUTHENTICATED','INVALID_CREDENTIALS','FORBIDDEN','NOT_FOUND','CONFLICT',
  'USERNAME_TAKEN','INVITE_INVALID','USER_LIMIT','LAST_ADMIN','CHANNEL_LIMIT','UPLOAD_QUOTA','PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA','RATE_LIMITED','LIVEKIT_UNAVAILABLE','STORAGE_FULL','INTERNAL']);
ApiErrorBody = { error: { code: ErrorCode, message: string, details?: unknown } }
// details: VALIDATION → zod flattened issues; RATE_LIMITED → { retryAfterMs }
Ack<T> = { ok: true, data: T } | { ok: false, error: ApiErrorBody['error'] }   // every socket client→server ack
```

HTTP status per code:

- **400:** VALIDATION, INVITE_INVALID
- **401:** UNAUTHENTICATED, INVALID_CREDENTIALS
- **403:** FORBIDDEN, USER_LIMIT
- **404:** NOT_FOUND
- **409:** CONFLICT, USERNAME_TAKEN, LAST_ADMIN, CHANNEL_LIMIT, UPLOAD_QUOTA
- **413:** PAYLOAD_TOO_LARGE
- **415:** UNSUPPORTED_MEDIA
- **429:** RATE_LIMITED
- **500:** INTERNAL (no internals leaked)
- **507:** STORAGE_FULL
- **503:** LIVEKIT_UNAVAILABLE

A socket handshake failure is a `connect_error` with `err.data = { code }`: `UNAUTHENTICATED` (missing, invalid or expired session), `FORBIDDEN` (`Origin` not in `APP_ORIGIN`) or `INTERNAL` (server error during the handshake).

### B.4 REST endpoints (prefix `/api`, JSON)

Rules that apply to every endpoint:

- **Auth** is the `hearth_session` cookie (httpOnly, SameSite=Lax, Secure when `COOKIE_SECURE`).
- **CSRF:** every request except GET/HEAD/OPTIONS needs the header `X-Requested-With: hearth`. The LiveKit webhook is exempt.
- **Access:** `access(ch)` = a text/voice channel for any active user, or a DM the user is a member of. A DM with a deactivated user is read-only.

| #   | Method & path                                            | Auth                                                              | Request                                                                                             | Response (2xx)                                                                                                                                                                  | Notable errors                                                                                                           |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | GET `/health`                                            | none                                                              | —                                                                                                   | `{status:'ok'\|'degraded', db:'ok'\|'down', livekit?:'ok'\|'down'}` (livekit key from P6); 503 + `status:'degraded'` if db down                                                 | —                                                                                                                        |
| 2   | POST `/auth/register`                                    | none                                                              | `{inviteCode, username, displayName, password}`                                                     | 201 `{user: Me}` + cookie                                                                                                                                                       | INVITE_INVALID, USERNAME_TAKEN, USER_LIMIT                                                                               |
| 3   | POST `/auth/login`                                       | none                                                              | `{username, password}`                                                                              | `{user: Me}` + cookie                                                                                                                                                           | INVALID_CREDENTIALS (also deactivated), RATE_LIMITED (10/min/IP)                                                         |
| 4   | POST `/auth/logout`                                      | user                                                              | —                                                                                                   | 204, clears cookie, closes this session's sockets                                                                                                                               | —                                                                                                                        |
| 5   | POST `/auth/reset-password`                              | none                                                              | `{username, code, newPassword}`                                                                     | 204; revokes all sessions → `session:revoked`                                                                                                                                   | INVALID_CREDENTIALS (bad/expired/used code), RATE_LIMITED                                                                |
| 6   | GET `/invites/:code/check`                               | none                                                              | —                                                                                                   | `{valid: boolean}`                                                                                                                                                              | RATE_LIMITED                                                                                                             |
| 7   | GET `/me`                                                | user                                                              | —                                                                                                   | `{user: Me}`                                                                                                                                                                    | —                                                                                                                        |
| 8   | PATCH `/me`                                              | user                                                              | `{displayName}`                                                                                     | `{user: Me}` → `user:updated`                                                                                                                                                   | —                                                                                                                        |
| 9   | POST `/me/password`                                      | user                                                              | `{currentPassword, newPassword}`                                                                    | 204; revokes other sessions                                                                                                                                                     | INVALID_CREDENTIALS                                                                                                      |
| 10  | PUT `/me/avatar`                                         | user                                                              | multipart `file` (png/jpeg/webp ≤2 MB)                                                              | `{user: Me}` → `user:updated`                                                                                                                                                   | PAYLOAD_TOO_LARGE, UNSUPPORTED_MEDIA                                                                                     |
| 11  | DELETE `/me/avatar`                                      | user                                                              | —                                                                                                   | `{user: Me}`                                                                                                                                                                    | —                                                                                                                        |
| 12  | GET `/bootstrap`                                         | user                                                              | —                                                                                                   | `{me, users: PublicUser[], channels: Channel[], dms: DmChannel[], readStates: ReadState[], voice: Record<Uuid, VoiceParticipant[]>, onlineUserIds: Uuid[], livekitUrl: string}` | —                                                                                                                        |
| 13  | GET `/users`                                             | user                                                              | —                                                                                                   | `{users: PublicUser[]}` (includes deactivated)                                                                                                                                  | —                                                                                                                        |
| 14  | GET `/avatars/:userId`                                   | user                                                              | `?v=` cache-buster                                                                                  | image bytes, `Cache-Control: private, max-age=86400`                                                                                                                            | NOT_FOUND                                                                                                                |
| 15  | POST `/channels`                                         | admin                                                             | `{type:'text'\|'voice', name}`                                                                      | 201 `{channel}` → `channel:created`                                                                                                                                             | CHANNEL_LIMIT (50)                                                                                                       |
| 16  | PATCH `/channels/:id`                                    | admin                                                             | `{name}`                                                                                            | `{channel}` → `channel:updated`                                                                                                                                                 | NOT_FOUND for an unknown or DM id                                                                                        |
| 17  | PUT `/channels/order`                                    | admin                                                             | `{ids: Uuid[]}` (every non-DM channel, new order)                                                   | `{channels}` → `channels:reordered`                                                                                                                                             | VALIDATION if set ≠ existing                                                                                             |
| 18  | DELETE `/channels/:id`                                   | admin                                                             | —                                                                                                   | 204; voice: LiveKit `deleteRoom` first → `channel:deleted`                                                                                                                      | LIVEKIT_UNAVAILABLE; NOT_FOUND for an unknown or DM id                                                                   |
| 19  | POST `/dms`                                              | user                                                              | `{userId}`                                                                                          | 200/201 `{channel: DmChannel}` (get-or-create) → `dm:created` to both                                                                                                           | FORBIDDEN (self/deactivated); NOT_FOUND for an unknown user                                                              |
| 20  | GET `/channels/:id/messages`                             | access                                                            | at most one of `?before=MessageId` / `?after=MessageId` (neither = latest page), `limit` 1–100 (50) | `{messages: Message[]}` ascending by id — a page shorter than `limit` means nothing more in that direction                                                                      | FORBIDDEN, NOT_FOUND                                                                                                     |
| 21  | POST `/channels/:id/messages`                            | access, text/dm                                                   | `{content, attachmentIds?: Uuid[] (≤10), nonce?: string(≤64)}`                                      | 201 `{message}` → `message:created`                                                                                                                                             | VALIDATION (empty and no attachments), FORBIDDEN, RATE_LIMITED (10/10 s); VALIDATION when the channel is a voice channel |
| 22  | PATCH `/messages/:id`                                    | author                                                            | `{content}`                                                                                         | `{message}` → `message:updated`                                                                                                                                                 | FORBIDDEN; VALIDATION if content becomes empty on a message without attachments (server-side check)                      |
| 23  | DELETE `/messages/:id`                                   | author, or admin (non-DM)                                         | —                                                                                                   | 204 → `message:deleted`; files unlinked after commit                                                                                                                            | FORBIDDEN; the author may delete own messages even in a read-only DM                                                     |
| 24  | PUT `/messages/:id/reactions/:emoji`                     | access                                                            | — (emoji URL-encoded)                                                                               | 204 idempotent → `reaction:added`                                                                                                                                               | VALIDATION, CONFLICT (>20 distinct emoji)                                                                                |
| 25  | DELETE `/messages/:id/reactions/:emoji`                  | access                                                            | —                                                                                                   | 204 → `reaction:removed`                                                                                                                                                        | —                                                                                                                        |
| 26  | POST `/channels/:id/read`                                | access                                                            | `{messageId}`                                                                                       | `{readState}` (forward-only) → `readstate:updated` to self                                                                                                                      | —                                                                                                                        |
| 27  | POST `/attachments`                                      | user                                                              | multipart `file` (≤25 MB)                                                                           | 201 `{attachment}` (unattached)                                                                                                                                                 | PAYLOAD_TOO_LARGE, RATE_LIMITED (20/min)                                                                                 |
| 28  | GET `/attachments/:id/:filename`                         | access to the message's channel, or the uploader while unattached | —                                                                                                   | bytes; `X-Content-Type-Options: nosniff`; `Content-Disposition` inline (png/jpeg/gif/webp) else attachment                                                                      | NOT_FOUND                                                                                                                |
| 28b | DELETE `/attachments/:id`                                | uploader, unattached only                                         | —                                                                                                   | 204; the file is unlinked after commit and it stops counting toward `UPLOAD_QUOTA`                                                                                              | NOT_FOUND (unknown, someone else's, or already attached)                                                                 |
| 29  | POST `/voice/:channelId/token`                           | user, voice channel                                               | —                                                                                                   | `{token, url, roomName, expiresAt}`                                                                                                                                             | NOT_FOUND, LIVEKIT_UNAVAILABLE                                                                                           |
| 30  | POST `/livekit/webhook`                                  | LiveKit signature (`WebhookReceiver`)                             | raw `application/webhook+json`                                                                      | 200                                                                                                                                                                             | 401 on a bad signature                                                                                                   |
| 31  | POST `/voice/:channelId/participants/:userId/disconnect` | admin                                                             | —                                                                                                   | 204                                                                                                                                                                             | NOT_FOUND                                                                                                                |
| 32  | GET `/admin/invites`                                     | admin                                                             | —                                                                                                   | `{invites}`                                                                                                                                                                     | —                                                                                                                        |
| 33  | POST `/admin/invites`                                    | admin                                                             | `{maxUses?: 1–25 (1), expiresInHours?: 1–720 (168)}`                                                | 201 `{invite}`                                                                                                                                                                  | —                                                                                                                        |
| 34  | DELETE `/admin/invites/:id`                              | admin                                                             | —                                                                                                   | 204 (sets revokedAt)                                                                                                                                                            | —                                                                                                                        |
| 35  | PATCH `/admin/users/:id`                                 | admin                                                             | `{role}`                                                                                            | `{user: PublicUser}` → `user:updated`                                                                                                                                           | LAST_ADMIN                                                                                                               |
| 36  | POST `/admin/users/:id/deactivate`                       | admin                                                             | —                                                                                                   | 204 (teardown, see B.7)                                                                                                                                                         | LAST_ADMIN                                                                                                               |
| 37  | POST `/admin/users/:id/reactivate`                       | admin                                                             | —                                                                                                   | 204 → `user:updated`                                                                                                                                                            | USER_LIMIT                                                                                                               |
| 38  | POST `/admin/users/:id/reset-code`                       | admin                                                             | —                                                                                                   | `{code, expiresAt}` (24 h, shown once)                                                                                                                                          | —                                                                                                                        |
| 39  | POST `/__test__/reset`                                   | only when `HEARTH_TEST_MODE`; header `X-Test-Token`               | —                                                                                                   | `{adminInviteCode}`; truncates DB, clears memory state, deletes LK rooms, drops sockets                                                                                         | —                                                                                                                        |
| 40  | POST `/__test__/seed-messages`                           | only when `HEARTH_TEST_MODE`; header `X-Test-Token`               | `{channelId, authorId, count: 1–500, prefix?: string(≤32, default "msg")}`                          | `{firstId: MessageId, lastId: MessageId}`; inserts `"<prefix> 1".."<prefix> n"` directly — no broadcasts, no rate limit                                                         | 404 when test mode is off, 403 on a bad token, NOT_FOUND for an unknown channel/author                                   |

Login, reset-password and current-password fields are validated leniently (any non-empty string ≤ 128 chars; reset code ≤ 64): bad values return `INVALID_CREDENTIALS`, not `VALIDATION`, so the response does not reveal the password rules. `ReorderChannelsRequest.ids` and `attachmentIds` must be unique.

Mentions are parsed server-side from `(?<![\w@])@([a-z0-9_]{3,32})` against active usernames with access to the channel. In DMs the other member always gets a notification.

### B.5 Socket.IO events (`packages/shared/src/socket.ts`)

- **Connection:** path `/socket.io`, same origin, **websocket transport only** (`transports: ['websocket']`). Browsers omit `Origin` on same-origin polling requests, so a polling handshake would fail the Origin check.
  - `io.use` checks `Origin ∈ APP_ORIGIN` and the session cookie.
  - The socket joins the rooms `all`, `user:<userId>` and `session:<sessionId>`.
- **Audience** (`realtime/audience.ts`): text/voice channel → room `all`; DM → `user:<a>` and `user:<b>`.
- **Emit rule:** every emit happens _after_ the transaction commits.

Client → server (zod-validated, ack `Ack<T>`, rate-limited in memory):

```ts
'typing:start': z.object({ channelId: Uuid })                        // ack Ack<null>; client throttles to 1 per 3 s
'voice:state':  z.object({ channelId: Uuid, selfMute: z.boolean(), selfDeaf: z.boolean(),
                           camera: z.boolean(), screen: z.boolean() })  // ack Ack<null>; stored in memory, broadcast if joined
```

Server → client (schemas also exported, for types and dev-mode assertion):

| Event                                 | Payload                                                                                   | Receivers                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| `message:created` / `message:updated` | `{message: Message}`                                                                      | channel audience                    |
| `message:deleted`                     | `{channelId, messageId}`                                                                  | channel audience                    |
| `reaction:added` / `reaction:removed` | `{channelId, messageId, emoji, userId}`                                                   | channel audience                    |
| `typing`                              | `{channelId, userId}` (client expires after 5 s)                                          | channel audience except sender      |
| `readstate:updated`                   | `{readState: ReadState}`                                                                  | `user:<self>` (multi-tab sync)      |
| `channel:created` / `channel:updated` | `{channel: Channel}`                                                                      | `all`                               |
| `channel:deleted`                     | `{channelId}`                                                                             | `all`                               |
| `channels:reordered`                  | `{channels: Channel[]}`                                                                   | `all`                               |
| `dm:created`                          | `{channel: DmChannel}`                                                                    | both members                        |
| `user:updated`                        | `{user: PublicUser}`                                                                      | `all`                               |
| `presence`                            | `{userId, online: boolean}` (offline after a 3 s grace period)                            | `all`                               |
| `voice:joined` / `voice:updated`      | `{channelId, participant: VoiceParticipant}`                                              | `all`                               |
| `voice:left`                          | `{channelId, userId}`                                                                     | `all`                               |
| `voice:kicked`                        | `{channelId, reason: 'admin'\|'channel_deleted'\|'deactivated'}`                          | `user:<id>` (the removed user only) |
| `session:revoked`                     | `{reason: 'logout'\|'deactivated'\|'password_changed'\|'password_reset'}` then disconnect | `session:<id>` or `user:<id>`       |

Reconnect protocol: on every `connect`, the client refetches `GET /bootstrap`, plus `GET messages?after=<lastSeenId>` for each loaded channel. All client stores upsert by id, so events are idempotent.

### B.5a Presence, typing, reads, reactions, mentions (Phase 4 rules)

1. **DM mentions:** every DM message creates a mention row for the other member, so `mentionUserIds` contains them. Mention counting and notifications then work the same way for channels and DMs.
2. **Mention parsing:**
   - Regex `(?<![\w@])@([a-z0-9_]{3,32})`, case-insensitive, deduplicated.
   - Only active users who can access the channel count (everyone for text channels, the two members for a DM). Self-mentions are ignored.
   - Editing a message recomputes its mentions. Only `message:created` triggers notifications.
3. **Read state (row 26):**
   - `messageId` must be a message in that channel, otherwise `VALIDATION`.
   - Forward-only (`GREATEST`).
   - `unread` means a message from **someone else** exists after `lastReadMessageId`.
   - `mentionCount` counts my mention rows after `lastReadMessageId`.
   - Sending a message moves the sender's read state forward to it and emits `readstate:updated` to the sender.
4. **Reactions (rows 24–25):**
   - Only changes are broadcast: a PUT for an existing reaction or a DELETE for a missing one returns 204 with no event.
   - A read-only DM (the other member is deactivated) gives `FORBIDDEN`.
   - `Reaction[]` is ordered by each emoji's first reaction time, and `userIds` by reaction time.
5. **Typing:**
   - Voice channel → ack `VALIDATION`. No access → ack `FORBIDDEN`.
   - The server broadcasts at most once per user+channel every 2 s. Extra events get an ok ack and are dropped.
   - Clients expire the indicator 5 s after the last `typing` event, and clear it immediately on a `message:created` from that user.
6. **Presence:**
   - Online while the user has at least one connected socket.
   - After the last socket disconnects, `online:false` is broadcast only after a 3 s grace period; a reconnect within it cancels the broadcast.
   - `presence` is emitted only on an actual change. The test reset clears presence state.

7. **Edge cases (settled during implementation):**
   - `typing:start` for an unknown channel acks `NOT_FOUND`; in a read-only DM it acks `FORBIDDEN`.
   - Reaction PUT and DELETE in a read-only DM return `FORBIDDEN`.
   - `mentionUserIds` is sorted by user id.
   - `POST /channels/:id/read` emits `readstate:updated` even when the position doesn't move (an older `messageId`), so the caller always gets the current state.
   - The server parses mentions from the raw text, including inside code spans. Such a mention counts and notifies even though the client doesn't highlight it inside code (a known minor inconsistency).
   - Messages created through `/__test__/seed-messages` get no mention rows.
   - Presence always waits for the grace period on disconnect. Deactivation (Phase 8) will add an immediate forced offline.

### B.6 LiveKit token and room contract

- **Room name:** `voice_<channelId>`.
- **Identity:** `userId`. **Name:** `displayName`.
- **TTL:** 10 min. The token is only needed to connect; LiveKit refreshes it for connected participants.
- **Grants:** identical for admins and members. Moderation goes through the server's `RoomServiceClient` (`removeParticipant`, `deleteRoom`).
  `{ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false, canPublishSources: [MICROPHONE, CAMERA, SCREEN_SHARE, SCREEN_SHARE_AUDIO], roomAdmin: false, roomCreate: false }`
- **Issued only if:** the channel exists, has `type='voice'`, and the user is active.
- **Server config:** `room.max_participants: 25`, `empty_timeout: 60`, `auto_create: true`.
- **Webhooks:**
  - `participant_joined` and `participant_left` update the in-memory map and trigger `voice:joined` / `voice:left`.
  - `room_finished` clears the room.
- **Reconcile:** `listRooms` + `listParticipants` runs on server boot and every 60 s.
- **One voice channel per user:** if a join arrives while the user is already in another room, the server calls `removeParticipant` on the old room.
- **Duplicate identity** (second device): LiveKit drops the older connection. This is the accepted behaviour.
- **Publish presets:** camera 720p30, screen 1080p30. Screen-share audio is allowed.

### B.6a Voice rules (Phase 6)

1. **Health (row 1):**
   - LiveKit reachability is a `listRooms` call with a 2 s timeout, cached for 10 s.
   - LiveKit down with the DB up gives **200** and `{status:'degraded', db:'ok', livekit:'down'}`. Only a DB outage returns 503.
2. **Token (row 29):**
   - Minting is local, so `LIVEKIT_UNAVAILABLE` comes back only when the cached health says LiveKit is down.
   - Rate limit: 30 per minute per user.
   - The response `url` is `LIVEKIT_PUBLIC_URL`.
3. **Webhook (row 30):**
   - The body is read as raw text: a Fastify content-type parser for `application/webhook+json` returns the string unparsed.
   - Handling is idempotent:
     - the last 1000 event `id`s are remembered and repeats are ignored;
     - participants are keyed by `(userId, participant.sid)`, so a stale `participant_left` for an older sid never removes a newer join;
     - `participant_connection_aborted` counts as left;
     - an event for a room whose channel isn't in **this** server's DB is ignored.
   - Ignoring foreign rooms matters because the dev server (:3000) and the e2e server (:3100) both get every webhook from the shared container.
4. **Voice state:**
   - The server keeps an in-memory `Map<channelId, Map<userId, VoiceParticipant>>`. `voice:state` from a client is stored per user and applied, via `voice:updated`, only while that user is in that channel. Otherwise the ack is `VALIDATION`.
   - Reconcile runs at boot and every 60 s: `listRooms` → Hearth rooms → `listParticipants`, compared against memory, emitting joined/left for any differences.
5. **One channel at a time:** a `participant_joined` for a user already in another room triggers `removeParticipant` on the old room (a 404 counts as success). The client also disconnects the old room before joining a new one.
6. **Test reset (row 39):** before truncating, it collects this DB's voice channel ids, `deleteRoom`s each one (404 is fine), and clears voice memory and the webhook id cache. Rooms from other databases on the shared container are left alone.

7. **Implementation details (settled in Phase 6):**
   - `VOICE_RECONCILE_MS` accepts 1000–3600000 (default 60000).
   - `/bootstrap.voice` lists only channels that currently have participants.
   - The webhook route accepts only `application/webhook+json` (a JSON body gets 415).
   - A `voice:state` sent before the join webhook arrives is acked `VALIDATION` but remembered, and becomes that user's starting mute/deafen flags on join. `voice:state` is limited to 20 events per 5 s per user (ack `RATE_LIMITED`).
   - LiveKit answering `deleteRoom`/`removeParticipant` with 404 counts as success.
   - Deleting a voice channel drops its participants from memory; `channel:deleted` follows. LiveKit's own `participant_left`/`room_finished` webhooks for the deleted room may still produce `voice:left` events first, which clients handle harmlessly.
   - Known race: someone joining in the milliseconds between `deleteRoom` and the DB delete re-creates the room (rooms auto-create); it closes when it empties.

### B.6b Camera and screen share (Phase 7)

1. **`camera`/`screen` flags** come from the client and are cosmetic, for the sidebar. The server cross-checks them in the 60 s reconcile: from `listParticipants`, a `ParticipantInfo.tracks[].source` without a published camera or screen track forces the flag to false and emits `voice:updated`. So a crashed client can't leave a LIVE badge stuck.
2. **Screen-share audio** is published only when the browser provides it (tab audio in Chromium). It follows the per-user volume slider for that sharer through `setVolume(v, Track.Source.ScreenShareAudio)`.
3. **Publish presets:** camera 720p30 with simulcast (LiveKit defaults). Screen 1080p30 with `contentHint: 'detail'`, and simulcast off for screen share (text sharpness over bandwidth at 6–8 users).

### B.7 Lifecycle rules (ordered, idempotent)

- **Deactivate user:**
  1. DB transaction: set `deactivatedAt`, delete sessions (guarded by the last-admin check).
  2. Emit `session:revoked` to `user:<id>` and disconnect those sockets.
  3. `removeParticipant` from any LiveKit room.
  4. Broadcast `user:updated` and `presence`.
- **Delete voice channel:**
  1. `deleteRoom` (a 404 counts as success).
  2. DB delete.
  3. Broadcast `channel:deleted`.
- **Delete text channel or message:**
  1. Collect the attachment storage keys.
  2. DB delete (cascades).
  3. Broadcast.
  4. Unlink the files; failures are logged, and the daily GC reconciles disk against the DB.
- **Upload:** stream to `UPLOAD_DIR/tmp/<uuid>` with a byte counter → sniff the type → `rename` into `UPLOAD_DIR/yyyy/mm/<uuid>` → insert the row. On abort or overflow, unlink the temp file; no row is ever written. The GC deletes unattached rows (and their files) older than 24 h, and temp files older than 1 h.

---

### B.7b Admin, moderation and lifecycle (Phase 8)

1. **Last-admin guard:** "the last active admin" is counted inside the same transaction under an advisory lock, so two admins demoting each other at the same time can't leave zero admins. The guard covers both demotion (row 35) and deactivation (row 36), whether the target is yourself or someone else.
2. **Deactivate is idempotent:** deactivating an already-deactivated user gives 204 with no events. Reactivating an active user gives 204 with no events.
3. **Reactivation:** restores the account, but not its sessions, so the user has to log in again. The username stays reserved while the account is deactivated (unchanged from §2).
4. **Voice disconnect (row 31):** a user who isn't in that room gives `NOT_FOUND`; LiveKit being unreachable gives `LIVEKIT_UNAVAILABLE`. The server also tells the client why via a new server→client event `voice:kicked {channelId, reason: 'admin'|'channel_deleted'|'deactivated'}` sent to `user:<id>`, so the UI can show a notice instead of a silent drop. **Contract addition: add it to B.5 and to the shared socket maps.**
5. **Deleted-user rendering:** clients render `PublicUser.deactivated === true` as "Deleted user" with a neutral avatar, both in message authors and in DM titles. A DM with a deactivated user becomes read-only (already enforced on the server in Phase 3).
6. **GC schedule:** already implemented in Phase 5 (B.7a rule 8 and `UPLOAD_GC_INTERVAL_MINUTES`): runs at startup and every interval, removes unattached uploads older than 24 h, temp files older than 1 h and orphan files on disk, under a session advisory lock. Phase 8 only reviews it.

7. **Settled in Phase 8 implementation:**
   - Deactivation sends `voice:kicked {reason:'deactivated'}` just before `session:revoked` (after that the sockets are closed); `removeParticipant` follows the revoke.
   - Admin voice disconnect sends `voice:kicked {reason:'admin'}` before `removeParticipant`; if LiveKit is already known to be down the route returns 503 before sending anything.
   - The voice reconcile and the join webhook also remove any deactivated user's LiveKit participant, closing the window in which an already-issued token would still work.
   - Registration, role change, deactivate and reactivate share one advisory lock (`USERS_LOCK_KEY`). Inside it, the last-admin guard runs first, then a check that the acting admin is still an admin.
   - `PATCH /admin/users/:id` returns 200 `{user}`; setting the same role again returns 200 with no event.
   - Deactivation also voids the user's unused reset codes and revokes the unused invites they created (in the same transaction).
   - Every admin mutation re-checks, inside its transaction, that the acting user is still an active admin.
   - A socket whose session is revoked while its handshake is in flight is disconnected right after it joins its rooms.
   - After a voice channel's DB delete commits, the server calls `deleteRoom` once more (404 = success), so a token minted in between can't leave a room behind.
   - CSP `connect-src` allows the LiveKit URL in both its `ws(s)://` and `http(s)://` forms (livekit-client makes HTTP validate and reconnect-probe requests).
   - Rate limits (each returns 429 `RATE_LIMITED` with `retryAfterMs`):

     | Limit                                         | Scope                                                       |
     | --------------------------------------------- | ----------------------------------------------------------- |
     | Login, register, reset-password, invite check | 10/min per IP, per route                                    |
     | Message send                                  | 10 per 10 s per user                                        |
     | Attachments, avatar PUT/DELETE                | 20/min per user, per route                                  |
     | Voice token                                   | 30/min per user                                             |
     | Reactions PUT + DELETE                        | 30 per 10 s per user, one shared window                     |
     | Admin mutations (rows 15–18, 31, 33–38)       | 60/min per admin, one shared window                         |
     | Change password (row 9)                       | 10/min per user                                             |
     | `voice:state` (socket)                        | 20 per 5 s per user; ack `RATE_LIMITED` with `retryAfterMs` |
     | `typing:start` (socket)                       | 10 per 5 s per user; excess acked ok and dropped (B.5a)     |

### B.7a Uploads and avatars (Phase 5 rules)

1. **B.8 `UPLOAD_DIR`:** a relative path is resolved against the **repo root**, not the process working directory (Docker keeps the absolute `/data/uploads`). The server creates `tmp/` and `avatars/` at startup and fails fast if they aren't writable.
2. **Storage layout (B.7):**
   - attachments: `<UPLOAD_DIR>/yyyy/mm/<uuid>`
   - avatars: `<UPLOAD_DIR>/avatars/<uuid>`
   - temp: `<UPLOAD_DIR>/tmp/<uuid>`
   - Storage keys are always server-generated. The client's filename never touches the path.
3. **Row 27:**
   - Exactly one multipart part, named `file`, is accepted (`limits: { files: 1, fields: 0, parts: 1 }`); anything else gets `VALIDATION`. A 0-byte file also gets `VALIDATION`.
   - Any type is accepted. `mimeType` is **sniffed** from the content, falling back to `application/octet-stream`; the client-declared type is ignored.
   - The filename is sanitized: basename only (both `/` and `\`), no control characters, at most 255 UTF-8 bytes, defaulting to `file`.
4. **Row 28:**
   - Anonymous → 401. No access, or someone else's unattached upload → **404 `NOT_FOUND`**, not 403, so existence isn't revealed. The `:filename` segment is cosmetic and ignored for lookup.
   - Response headers:
     - `Content-Type` = the stored `mimeType` **only** for the `INLINE_IMAGE_MIME_TYPES` allowlist; every other file is served as `application/octet-stream`, whatever was sniffed (for example `application/xml` for an SVG with an `<?xml` prolog, or `application/pdf`). The `Attachment.mimeType` in the API still carries the sniffed value.
     - `X-Content-Type-Options: nosniff`
     - `Content-Security-Policy: default-src 'none'; sandbox`
     - `Cache-Control: private, max-age=31536000, immutable`
     - `Content-Disposition`: `inline` only for the `INLINE_IMAGE_MIME_TYPES` allowlist, otherwise `attachment`, always with `filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>` (RFC 5987/6266).
   - SVG and HTML are never served inline: file-type may detect nothing (→ `application/octet-stream`) or `application/xml`, and either way the response is `application/octet-stream` with `attachment` disposition.
5. **Rows 10, 11, 14:**
   - The sniffed type must be in `AVATAR_MIME_TYPES`, otherwise `415 UNSUPPORTED_MEDIA`. Over 2 MB → `413`.
   - `avatarUrl` = `/api/avatars/<userId>?v=<first 8 chars of the storage uuid>`, or `null`.
   - A replaced or deleted avatar file is unlinked after commit.
   - Deactivated users' avatars are still served, so old messages render.
6. **New env `UPLOAD_GC_INTERVAL_MINUTES`** (default `60`, `0` disables) in B.8 and `.env.example`.
7. **Web error mapping:** an HTTP 413 whose body isn't an `ApiErrorBody` (Caddy's own 413 when a body exceeds `max_size 26MiB`; Caddy reads `MB` as 10⁶ bytes, so the cap is written in MiB to stay above the server's 25 MiB limit plus multipart framing) is mapped to `PAYLOAD_TOO_LARGE`.

8. **Disk-fill guards (row 27, and row 10 for the free-space check):**
   - Before streaming, the server refuses an upload when the user already has ≥ `LIMITS.unattachedUploadsMaxFiles` (30) unattached uploads or ≥ `LIMITS.unattachedUploadsMaxBytes` (250 MiB) of them → `409 UPLOAD_QUOTA`. Attaching them to a message (or the 24 h GC) frees the quota.
   - It also refuses any upload (attachments and avatars) when the free space on the `UPLOAD_DIR` filesystem is below `UPLOAD_MIN_FREE_MB` (default 2048) → `507 STORAGE_FULL`.
   - Avatar PUT and DELETE each have the upload rate limit (20/min/user, a separate counter per route).
   - The web maps `UPLOAD_QUOTA` → "Too many files waiting to be sent. Send or remove some first." and `STORAGE_FULL` → "The server is out of storage space. Tell an admin."

### B.9 Hardening rules (bug-hunt round, 2026-09-30)

1. **Input:** every string field in requests (and socket payloads) rejects the NUL character `\u0000` with `400 VALIDATION` (or, for the lenient login/reset/invite fields, the same answer as a wrong value: `INVALID_CREDENTIALS` / `INVITE_INVALID` / `{valid:false}`). No request may reach Postgres with a NUL and produce a 500.
2. **CSRF:** the `X-Requested-With: hearth` header is required on every request except GET/HEAD/OPTIONS and the exact LiveKit webhook route, decided from the matched route, never from the raw (possibly percent-encoded) URL.
3. **Credentials are consistent under concurrency:** login, change-password, reset-password, deactivate and reactivate serialize on the target user's row; a session is only created if the verified password hash is still current and the user is still active; a change-password request whose own session was revoked mid-flight fails with 401. Changing or resetting a password voids that user's unused reset codes; issuing a code voids older ones atomically.
4. **Config:** `APP_ORIGIN` entries are normalized to their origin (scheme://host[:port], no path or trailing slash); a value with a path is rejected at boot.
5. **Codes:** invite and reset codes are matched case-insensitively with Crockford normalization (`O`→`0`, `I`/`L`→`1`).
6. **Messages:** sending to (or reacting in) a channel that was deleted concurrently returns `404 NOT_FOUND`, never 500. Deleting or editing a message that changes someone's unread/mention state sends that user a fresh `readstate:updated`.
7. **Uploads:** the `UPLOAD_QUOTA` check is enforced atomically (per-user lock) so concurrent uploads can't overshoot it; the client deletes an unattached upload (row 28b) when its chip is removed or the composer unmounts.
8. **Voice:** the voice reconcile never kicks a connection whose sid differs from the one it listed; a same-channel LiveKit reconnect (left then joined within a short grace) keeps the participant's mute/deafen flags and doesn't broadcast a leave/join flicker; a deactivation racing a join webhook still removes the user.
   - Settled in implementation:
     - The rejoin grace is 5 s. It applies to a `participant_left` / `participant_connection_aborted` whose `disconnectReason` is not `CLIENT_INITIATED`, `PARTICIPANT_REMOVED`, `ROOM_DELETED` or `ROOM_CLOSED` (those end the membership at once). During the grace the user stays listed; a join in the same room keeps flags and join time with no event; a join in another room ends the old membership at once (`voice:left`), without a kick; otherwise `voice:left` follows when the grace ends.
     - The reconcile's `removeParticipant` for an extra room is queued behind the webhooks received so far and skipped if the user is by then in that room on another sid (deactivated users are always removed).
     - Deactivation reads the user's voice membership behind the webhooks already received, after its commit.
     - Webhook ids (B.6a rule 3) are remembered only once handled successfully; a copy that arrives while the first is in flight waits for it and handles the event itself if the first failed.
     - Row 31 (admin voice disconnect) re-checks, under the shared users lock, that the actor is still an active admin (B.7b rule 7).
     - Web: switching voice channels leaves the old room at once, in parallel with the token request (10 s timeout, then a failure notice); a `RATE_LIMITED` ack for `voice:state` re-sends the current state after `retryAfterMs`; `channel:deleted` for the channel the tab is in or joining leaves voice with a notice; socket events that patch the cached bootstrap are replayed on top of a bootstrap response requested before them, and a deleted voice channel's participants are tombstoned against an older snapshot.

### B.10 Polish-pass rules (2026-09-30)

1. **Channel names are unique** among text and voice channels, compared case-insensitively after trimming. Creating or renaming to a taken name returns `409 CONFLICT` with the message "A channel with that name already exists." (enforced by a unique index on `lower(name)` for non-DM channels, added by a Drizzle migration).

### B.8 Runtime topology (ports, URLs, env)

|                                              | web (browser URL)                             | server                                         | Postgres DB               | LiveKit (browser)                  | LiveKit (server→LK)              | LK webhook → server                                  |
| -------------------------------------------- | --------------------------------------------- | ---------------------------------------------- | ------------------------- | ---------------------------------- | -------------------------------- | ---------------------------------------------------- |
| **dev** (`pnpm infra:up` + `pnpm dev`)       | http://localhost:5173 (Vite)                  | :3000 (tsx watch)                              | `hearth` @ localhost:5432 | ws://localhost:7880                | http://localhost:7880            | http://host.docker.internal:3000                     |
| **e2e** (Playwright webServer)               | http://localhost:5273 (Vite)                  | :3100                                          | `hearth_e2e`              | ws://localhost:7880                | http://localhost:7880            | http://host.docker.internal:3100                     |
| **unit** (Vitest)                            | —                                             | in-process `app.inject` / ephemeral port       | `hearth_unit`             | —                                  | —                                | —                                                    |
| **full stack** (`docker compose up --build`) | http://localhost:8080 (Caddy container `web`) | container :3000 (also published on host :3000) | `hearth` @ postgres:5432  | ws://localhost:7880                | http://livekit:7880              | host.docker.internal:3000                            |
| **prod** (P9)                                | https://$HEARTH_DOMAIN (Caddy :443)           | :3000 bound to 127.0.0.1                       | `hearth` (internal)       | wss://lk.$HEARTH_DOMAIN (Caddy→LK) | http://host.docker.internal:7880 | http://127.0.0.1:3000 (LK runs with host networking) |

- **Vite proxy:** `/api` and `/socket.io` (ws) go to `http://localhost:${HEARTH_API_PORT}`. The browser only ever talks to one origin, so no CORS is needed.
- **Caddy in the local full stack:**
  - `:8080` serves `/srv` (the web build) with SPA fallback.
  - `/api/*` and `/socket.io/*` are proxied to `server:3000`.
  - Request bodies are capped at 26 MiB.
- **LiveKit in dev/e2e/full stack:**
  - One container, `rtc.node_ip: 127.0.0.1`, single UDP port 7882 (mux), TCP fallback 7881.
  - Keys come from the `LIVEKIT_KEYS` env var.
  - `extra_hosts: host.docker.internal:host-gateway`.
  - `webhook.urls` lists both :3000 and :3100 (a failed delivery to whichever server isn't running is harmless). Missed webhooks are covered by a 60 s reconcile loop.
- **Env (`.env.example`):**
  - App: `NODE_ENV, PORT=3000, APP_ORIGIN=http://localhost:5173, LOG_LEVEL=info, TRUST_PROXY=false` (`false`/empty = trust no proxy; otherwise a comma-separated list of proxy IPs/CIDRs whose `X-Forwarded-For` is trusted — the full stack sets Caddy's fixed IP `172.28.0.10`, so rate limits key on the real client IP and direct hits on :3000 cannot forge it)
  - Database: `POSTGRES_USER=hearth, POSTGRES_PASSWORD=hearth, POSTGRES_DB=hearth, DATABASE_URL=postgres://hearth:hearth@localhost:5432/hearth, DATABASE_URL_UNIT=…/hearth_unit, DATABASE_URL_E2E=…/hearth_e2e, MIGRATE_ON_START=false`
  - Accounts: `COOKIE_SECURE=false, SESSION_TTL_DAYS=30, MAX_USERS=25`
  - Uploads: `UPLOAD_DIR=./data/uploads` (a relative path resolves against the repo root), `UPLOAD_GC_INTERVAL_MINUTES=60` (`0` disables the upload GC), `UPLOAD_MIN_FREE_MB=2048` (uploads refused with `STORAGE_FULL` below this much free space)
  - LiveKit: `LIVEKIT_URL=http://localhost:7880, LIVEKIT_PUBLIC_URL=ws://localhost:7880, LIVEKIT_API_KEY=devkey, LIVEKIT_API_SECRET=<≥32 chars>, LIVEKIT_KEYS="devkey: <same secret>"`
  - Voice: `VOICE_RECONCILE_MS=60000` (optional; how often the server reconciles its voice state with LiveKit; the e2e server uses 5000)
  - Testing: `HEARTH_TEST_MODE=false, HEARTH_TEST_TOKEN=`
  - Production (`docker-compose.prod.yml`, `.env.prod` from `infra/scripts/gen-secrets.sh`, see `.env.prod.example`): `HEARTH_DOMAIN` (e.g. `myhearth.duckdns.org`), `ACME_EMAIL`, `BACKUP_AT` (UTC `HH:MM`), `BACKUP_KEEP` (nightly backups kept, default 7), `BACKUP_KEEP_EXTRA` (pre-deploy and pre-restore backups kept per kind, default 3), `BACKUP_MIN_FREE_MB` (backups refused below max(1.5 × data size, this), default 2048), optional `NODE_IP` (the reserved public IP; LiveKit then skips STUN); `LIVEKIT_KEYS` is derived in compose from `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`; the server gets `APP_ORIGIN=https://$HEARTH_DOMAIN`, `LIVEKIT_PUBLIC_URL=wss://lk.$HEARTH_DOMAIN`, `LIVEKIT_URL=http://host.docker.internal:7880`, `TRUST_PROXY=172.29.0.10` (Caddy's pinned IP on the prod network `172.29.0.0/24`; `host.docker.internal` = the gateway `172.29.0.1`), `COOKIE_SECURE=true`, `HEARTH_TEST_MODE=false`. HSTS is set by Caddy in prod only.
- **LAN test profile** (`pnpm lan:up`, `docker-compose.lan.yml`): web over `https://<LAN_IP>:8443` and LiveKit signaling over `wss://<LAN_IP>:7443`, both through Caddy with `tls internal`; LiveKit starts with `--node-ip <LAN_IP>`; the server gets `APP_ORIGIN=https://<LAN_IP>:8443`, `LIVEKIT_PUBLIC_URL=wss://<LAN_IP>:7443`, `COOKIE_SECURE=true`. See docs/DEPLOY.md → LAN testing.
- The server parses env with zod in `env.ts` and exits on anything invalid. It refuses to boot when `NODE_ENV=production` and `HEARTH_TEST_MODE=true`.
