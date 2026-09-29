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
Reaction    = { emoji, userIds: Uuid[] }                                        // count = userIds.length
Message     = { id: MessageId, channelId, authorId, content, createdAt, editedAt: IsoDate|null,
                attachments: Attachment[], reactions: Reaction[], mentionUserIds: Uuid[], nonce: string|null }
ReadState   = { channelId, lastReadMessageId: MessageId|'0', unread: boolean, mentionCount: number }
Invite      = { id, code, maxUses, uses, expiresAt, revokedAt: IsoDate|null, createdAt, createdBy: Uuid|null }
VoiceParticipant = { userId, joinedAt, selfMute, selfDeaf, camera, screen }
```

### B.3 Error format (REST and sockets)

```ts
ErrorCode = z.enum(['VALIDATION','UNAUTHENTICATED','INVALID_CREDENTIALS','FORBIDDEN','NOT_FOUND','CONFLICT',
  'USERNAME_TAKEN','INVITE_INVALID','USER_LIMIT','LAST_ADMIN','CHANNEL_LIMIT','PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA','RATE_LIMITED','LIVEKIT_UNAVAILABLE','INTERNAL']);
ApiErrorBody = { error: { code: ErrorCode, message: string, details?: unknown } }
// details: VALIDATION → zod flattened issues; RATE_LIMITED → { retryAfterMs }
Ack<T> = { ok: true, data: T } | { ok: false, error: ApiErrorBody['error'] }   // every socket client→server ack
```

HTTP status per code:

- **400:** VALIDATION, INVITE_INVALID
- **401:** UNAUTHENTICATED, INVALID_CREDENTIALS
- **403:** FORBIDDEN, USER_LIMIT
- **404:** NOT_FOUND
- **409:** CONFLICT, USERNAME_TAKEN, LAST_ADMIN, CHANNEL_LIMIT
- **413:** PAYLOAD_TOO_LARGE
- **415:** UNSUPPORTED_MEDIA
- **429:** RATE_LIMITED
- **500:** INTERNAL (no internals leaked)
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

| Event                                 | Payload                                                                                   | Receivers                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| `message:created` / `message:updated` | `{message: Message}`                                                                      | channel audience               |
| `message:deleted`                     | `{channelId, messageId}`                                                                  | channel audience               |
| `reaction:added` / `reaction:removed` | `{channelId, messageId, emoji, userId}`                                                   | channel audience               |
| `typing`                              | `{channelId, userId}` (client expires after 5 s)                                          | channel audience except sender |
| `readstate:updated`                   | `{readState: ReadState}`                                                                  | `user:<self>` (multi-tab sync) |
| `channel:created` / `channel:updated` | `{channel: Channel}`                                                                      | `all`                          |
| `channel:deleted`                     | `{channelId}`                                                                             | `all`                          |
| `channels:reordered`                  | `{channels: Channel[]}`                                                                   | `all`                          |
| `dm:created`                          | `{channel: DmChannel}`                                                                    | both members                   |
| `user:updated`                        | `{user: PublicUser}`                                                                      | `all`                          |
| `presence`                            | `{userId, online: boolean}` (offline after a 3 s grace period)                            | `all`                          |
| `voice:joined` / `voice:updated`      | `{channelId, participant: VoiceParticipant}`                                              | `all`                          |
| `voice:left`                          | `{channelId, userId}`                                                                     | `all`                          |
| `session:revoked`                     | `{reason: 'logout'\|'deactivated'\|'password_changed'\|'password_reset'}` then disconnect | `session:<id>` or `user:<id>`  |

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
     - `Content-Type` = the stored `mimeType`
     - `X-Content-Type-Options: nosniff`
     - `Content-Security-Policy: default-src 'none'; sandbox`
     - `Cache-Control: private, max-age=31536000, immutable`
     - `Content-Disposition`: `inline` only for the `INLINE_IMAGE_MIME_TYPES` allowlist, otherwise `attachment`, always with `filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>` (RFC 5987/6266).
   - SVG and HTML are never sniffed as images (file-type doesn't detect text formats), so they're always served as `application/octet-stream` downloads.
5. **Rows 10, 11, 14:**
   - The sniffed type must be in `AVATAR_MIME_TYPES`, otherwise `415 UNSUPPORTED_MEDIA`. Over 2 MB → `413`.
   - `avatarUrl` = `/api/avatars/<userId>?v=<first 8 chars of the storage uuid>`, or `null`.
   - A replaced or deleted avatar file is unlinked after commit.
   - Deactivated users' avatars are still served, so old messages render.
6. **New env `UPLOAD_GC_INTERVAL_MINUTES`** (default `60`, `0` disables) in B.8 and `.env.example`.
7. **Web error mapping:** an HTTP 413 whose body isn't an `ApiErrorBody` (Caddy's own 413 when a body exceeds `max_size 26MB`) is mapped to `PAYLOAD_TOO_LARGE`.

### B.8 Runtime topology (ports, URLs, env)

|                                              | web (browser URL)                             | server                                         | Postgres DB               | LiveKit (browser)                  | LiveKit (server→LK)              | LK webhook → server                                  |
| -------------------------------------------- | --------------------------------------------- | ---------------------------------------------- | ------------------------- | ---------------------------------- | -------------------------------- | ---------------------------------------------------- |
| **dev** (`pnpm infra:up` + `pnpm dev`)       | http://localhost:5173 (Vite)                  | :3000 (tsx watch)                              | `hearth` @ localhost:5432 | ws://localhost:7880                | http://localhost:7880            | http://host.docker.internal:3000                     |
| **e2e** (Playwright webServer)               | http://localhost:5273 (Vite)                  | :3100                                          | `hearth_e2e`              | ws://localhost:7880                | http://localhost:7880            | http://host.docker.internal:3100                     |
| **unit** (Vitest)                            | —                                             | in-process `app.inject` / ephemeral port       | `hearth_unit`             | —                                  | —                                | —                                                    |
| **full stack** (`docker compose up --build`) | http://localhost:8080 (Caddy container `web`) | container :3000 (also published on host :3000) | `hearth` @ postgres:5432  | ws://localhost:7880                | http://livekit:7880              | host.docker.internal:3000                            |
| **prod** (P9)                                | https://hearth.$DOMAIN (Caddy :443)           | :3000 bound to 127.0.0.1                       | `hearth` (internal)       | wss://lk.hearth.$DOMAIN (Caddy→LK) | http://host.docker.internal:7880 | http://127.0.0.1:3000 (LK runs with host networking) |

- **Vite proxy:** `/api` and `/socket.io` (ws) go to `http://localhost:${HEARTH_API_PORT}`. The browser only ever talks to one origin, so no CORS is needed.
- **Caddy in the local full stack:**
  - `:8080` serves `/srv` (the web build) with SPA fallback.
  - `/api/*` and `/socket.io/*` are proxied to `server:3000`.
  - Request bodies are capped at 26 MB.
- **LiveKit in dev/e2e/full stack:**
  - One container, `rtc.node_ip: 127.0.0.1`, single UDP port 7882 (mux), TCP fallback 7881.
  - Keys come from the `LIVEKIT_KEYS` env var.
  - `extra_hosts: host.docker.internal:host-gateway`.
  - `webhook.urls` lists both :3000 and :3100 (a failed delivery to whichever server isn't running is harmless). Missed webhooks are covered by a 60 s reconcile loop.
- **Env (`.env.example`):**
  - App: `NODE_ENV, PORT=3000, APP_ORIGIN=http://localhost:5173, LOG_LEVEL=info, TRUST_PROXY=false` (`false`/empty = trust no proxy; otherwise a comma-separated list of proxy IPs/CIDRs whose `X-Forwarded-For` is trusted — the full stack sets Caddy's fixed IP `172.28.0.10`, so rate limits key on the real client IP and direct hits on :3000 cannot forge it)
  - Database: `POSTGRES_USER=hearth, POSTGRES_PASSWORD=hearth, POSTGRES_DB=hearth, DATABASE_URL=postgres://hearth:hearth@localhost:5432/hearth, DATABASE_URL_UNIT=…/hearth_unit, DATABASE_URL_E2E=…/hearth_e2e, MIGRATE_ON_START=false`
  - Accounts: `COOKIE_SECURE=false, SESSION_TTL_DAYS=30, MAX_USERS=25`
  - Uploads: `UPLOAD_DIR=./data/uploads` (a relative path resolves against the repo root), `UPLOAD_GC_INTERVAL_MINUTES=60` (`0` disables the upload GC)
  - LiveKit: `LIVEKIT_URL=http://localhost:7880, LIVEKIT_PUBLIC_URL=ws://localhost:7880, LIVEKIT_API_KEY=devkey, LIVEKIT_API_SECRET=<≥32 chars>, LIVEKIT_KEYS="devkey: <same secret>"`
  - Testing: `HEARTH_TEST_MODE=false, HEARTH_TEST_TOKEN=`
  - Production: `HEARTH_DOMAIN=` (P9)
- The server parses env with zod in `env.ts` and exits on anything invalid. It refuses to boot when `NODE_ENV=production` and `HEARTH_TEST_MODE=true`.
