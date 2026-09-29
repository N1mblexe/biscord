# Phase 3 plan — Text channels, DMs, messaging

Status: **approved 2026-09-28**. Source: PLAN.md §5 Phase 3 and CONTRACTS.md B.4/B.5/B.7.
Starts only after Phase 2 is committed.

## Goal

Friends can talk:

- Admins manage text and voice channels.
- Everyone chats in text channels and 1:1 DMs, in real time.
- Messages render in safe Markdown.
- History pages backwards.
- A client that drops offline catches up on reconnect without a reload.

## In scope (CONTRACTS B.4 rows)

| Group     | Rows                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Bootstrap | 12 `GET /bootstrap` (staged, see below)                                                                  |
| Channels  | 15 create · 16 rename · 17 reorder · 18 delete                                                           |
| DMs       | 19 `POST /dms` (get-or-create)                                                                           |
| Messages  | 20 history · 21 send · 22 edit · 23 delete                                                               |
| Test      | **new row 40** `POST /api/__test__/seed-messages` (test mode only)                                       |
| Socket    | `message:created/updated/deleted`, `channel:created/updated/deleted`, `channels:reordered`, `dm:created` |

**Staged:** `/bootstrap` returns the real `me`, `users`, `channels`, `dms` and `livekitUrl`. It returns `readStates: []` until Phase 4, `onlineUserIds: []` until Phase 4, and `voice: {}` until Phase 6. Every `Message` carries `reactions: []` and `mentionUserIds: []` until Phase 4, and `attachments: []` until Phase 5. An `attachmentIds` value that isn't a real attachment gets `VALIDATION`.

**Deferred:**

| Deferred item                                      | Moves to |
| -------------------------------------------------- | -------- |
| Reactions, read markers (24–26)                    | Phase 4  |
| Mentions, typing, presence                         | Phase 4  |
| Uploads                                            | Phase 5  |
| LiveKit `deleteRoom` when deleting a voice channel | Phase 6  |

In Phase 3 a voice channel is only a DB row, shown in the sidebar but not joinable.

## Contract changes (CONTRACTS.md + shared, in the same commit)

1. **Row 40 (test mode only):** `POST /api/__test__/seed-messages` takes `{ channelId, authorId, count (1–500), prefix? }` and returns `{ firstId, lastId }`. It inserts messages `"<prefix> 1".."<prefix> n"` directly, without broadcasts or rate limits. The scrollback e2e test needs it because 10 messages per 10 s makes seeding 120 through the API impossible.
2. **Row 21:** posting to a voice channel gives `400 VALIDATION` ("Cannot post in a voice channel").
3. **Row 20:** if a history page is shorter than `limit`, there are no more messages in that direction. No extra field is added.

## Key decisions

- **Access** (`services/access.ts`): `loadChannelForUser(user, channelId)` gives 404 for an unknown channel. For a DM, a non-member gets 403 `FORBIDDEN`, and sending to a DM with a deactivated user also gets 403. The message, DM and delete services all use this one function.
- **Audience** (`realtime/audience.ts`): `emitToChannel(channel, event, payload)` goes to room `all` for text/voice channels and to `user:<a>` and `user:<b>` for a DM. It's called only after the transaction commits, and a Vitest test proves a failed insert emits nothing.
- **Channels:**
  - One `position` ordering across text and voice. The UI groups them by type but keeps that order.
  - Create appends at `max(position) + 1`.
  - Reorder must list exactly the set of non-DM channels, or it gets `VALIDATION`.
  - More than 50 channels gets `CHANNEL_LIMIT`.
  - Delete cascades to the channel's messages.
- **DMs:** get-or-create keyed on the `(low, high)` user pair. A concurrent create is caught on the unique index and re-read. A new DM gets 201 and a `dm:created` event to both members; an existing one gets 200 and no event. A DM with yourself gets `FORBIDDEN`.
- **Messages:**
  - Content is trimmed and at most 4000 characters, and an empty message needs attachments. The `nonce` is echoed back.
  - An edit sets `editedAt`, and it can't leave the message empty unless it has attachments.
  - Delete: the author can always delete; an admin can delete in text channels but **not** in DMs.
  - Sending is limited to 10 per 10 s per **user** (rate-limit key = user id).
  - History uses `id < before` or `id > after` (index `(channel_id, id)`) and always comes back ascending.
- **Web state:**
  - TanStack Query holds `['bootstrap']`. Socket events patch it: channel create/update/delete, reorder, `dm:created`, `user:updated`.
  - A **zustand** message store is keyed by channel and normalized by message id: sorted ids, `hasOlder`, and pending sends by nonce. Every write is an idempotent upsert by id; nonce matching replaces the optimistic copy; everything is ordered by id.
  - Socket reconnects are tuned to about 2 s at most between attempts. On every reconnect after the first connect, the client:
    1. invalidates `['bootstrap']`;
    2. for each loaded channel, pages `?after=<lastId>` until a page comes back shorter than the limit.
- **Markdown:**
  - `react-markdown` + `remark-gfm`, with no raw HTML.
  - Allowed elements: `p`, `strong`, `em`, `del`, `code`, `pre`, `a`, `ul`, `ol`, `li`, `blockquote`, `br`. Anything else is unwrapped, so there are no images, headings or tables.
  - Links get `target="_blank" rel="noopener noreferrer"`, and the default `urlTransform` strips `javascript:` URLs.
- **Routes:** `/channels/:channelId` serves text channels and DMs. `/` redirects to the first text channel, or shows an empty state that tells admins to create one. A deleted channel sends viewers to `/` with a notice.
- **Debug hook (e2e builds only):** when `VITE_E2E=true`, `window.__hearthEvents` records `{ event, channelId }` for every server→client socket event. The DM-privacy test uses it to prove no event reached a third user.

## Web UI contract (for parallel e2e work)

| Where             | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar           | Sections headed **Text channels**, **Voice channels** and **Direct messages**. Text channels and DMs are links `data-testid="channel-link"` whose name is the child `data-testid="channel-link-name"` (exact text: the channel name, or the other user's display name for a DM); voice channels are non-link entries `data-testid="voice-channel"` (not joinable until Phase 6) whose text is the channel name (DMs show the other user's display name). The current one has `aria-current="page"`. |
| Channel header    | `data-testid="channel-title"`: `#name`, or the display name for a DM.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Message list      | Each message is `data-testid="message-item"` with `data-message-id`, containing `message-author` (display name), `message-content` (rendered Markdown) and, if edited, `message-edited` ("(edited)"). A button **Load older messages** is visible while `hasOlder`; scrolling to the top also loads older messages.                                                                                                                                                                                 |
| Message actions   | Own messages: buttons **Edit** and **Delete**. Admins in text channels: **Delete** on every message. Edit mode: a textbox labelled **Edit message**, buttons **Save** and **Cancel** (Enter saves, Escape cancels). Delete asks with `confirm()`.                                                                                                                                                                                                                                                   |
| Composer          | Textbox labelled **Message** (placeholder `Message #name`). Enter sends, Shift+Enter adds a newline, button **Send**. A pending message has `data-pending="true"` until confirmed.                                                                                                                                                                                                                                                                                                                  |
| Members panel     | `data-testid="member-item"` per active user, with the display name and a **Message** button (hidden for yourself) that opens or creates the DM and navigates to it.                                                                                                                                                                                                                                                                                                                                 |
| `/admin/channels` | Create form: **Name**, a **Type** select (Text/Voice), button **Create channel**. Rows `data-testid="channel-row"` with buttons **Rename** (inline textbox **New name** + **Save**), **Move up**, **Move down**, **Delete**. Delete opens a dialog with a textbox **Type the channel name to confirm** and button **Delete channel**, enabled only when the typed name matches.                                                                                                                     |
| Notices           | Channel deleted while viewing it: `data-testid="app-notice"` "This channel was deleted."                                                                                                                                                                                                                                                                                                                                                                                                            |

## Execution (tech lead + subagents)

1. **Lead:**
   - Commit Phase 2.
   - Add web deps `react-markdown@10.1.0`, `remark-gfm@4.0.1`, `zustand@5.0.15`.
   - Contract changes 1–3 in CONTRACTS.md, plus the new shared schemas `TestSeedMessagesRequest`/`TestSeedMessagesResponse`.
2. **Parallel:**
   - **server agent** (`apps/server/**`): access, audience, channels, DMs, messages, bootstrap, seed endpoint, Vitest.
   - **web agent** (`apps/web/**`): sidebar, channel view, message store, composer, Markdown, members panel, admin channels page, reconnect catch-up, debug hook, unit tests.
   - **e2e agent** (`e2e/**`): the specs below, plus fixture helpers `createChannel`, `openDm`, `seedMessages`.
3. **Fresh reviewer**, then the lead runs acceptance (both modes, 3× repeat), updates PROGRESS.md and commits `phase 3: …`.

## Acceptance tests

**Vitest (server, real DB):**

- Channel CRUD: members get 403; `CHANNEL_LIMIT`; reorder with a mismatched set gets `VALIDATION`; delete cascades to messages.
- DM get-or-create: idempotent (201 then 200); concurrent creates produce exactly one row; self and deactivated users get `FORBIDDEN`.
- Messages:
  - access (a DM non-member gets 403; posting to voice gets `VALIDATION`);
  - trim, empty and 4001 characters are rejected; the nonce is echoed;
  - `before`/`after`/`limit` paging, always ascending;
  - edit: only the author, sets `editedAt`, can't leave it empty;
  - delete: the author yes; an admin in a text channel yes, in a DM no;
  - the 11th send within 10 s gets 429.
- Sockets: with three connected users, a text-channel message reaches all three, and a DM message reaches only its two members. A failed write emits nothing. `channel:*` and `dm:created` reach the right audiences.
- Bootstrap: the response shape matches the shared schema, and DMs appear only for their members.
- Seed endpoint: 404 when test mode is off, 403 on a bad token.

**Playwright (dev-server mode, multi-user fixture):**

1. A and B are in `#general`. A sends a message and B sees it **within 1 s**. A edits it and B sees the new text plus "(edited)". A deletes it and it disappears for B.
2. DM privacy: A opens a DM with B from the members panel and sends a message, and B sees it under Direct messages. C's `GET /api/channels/<dmId>/messages` gets 403, and C's `window.__hearthEvents` contains no event for `dmId`.
3. Scrollback: seed 120 messages, open the channel, and only the newest 50 are rendered. Load older twice and messages 1–120 are all present, in order, with no duplicates.
4. Offline catch-up: B's context goes offline (`context.setOffline(true)`) and A sends 3 messages. B comes back online, and within about 5 s B sees all 3 without a reload, in order and with no duplicates.
5. Admin channel management (B watching live):
   - Create `#random`: it appears in B's sidebar.
   - Rename it: B's sidebar updates.
   - Move it up: B's order updates.
   - Delete it while B is viewing it: B lands on `/` and sees the `app-notice`.
6. Markdown safety: `**bold**` renders as `<strong>`. The text `<img src=x onerror=alert(1)>` renders as plain text, with no `img` element. `[x](javascript:alert(1))` produces no `javascript:` href.
7. Member permissions: B, a member, sees no **Delete** button on A's message and gets no Admin link, and B's `DELETE /api/messages/<A's id>` gets 403.

**Full stack:** the `@smoke` specs against the containers, plus a manual check through Caddy: send a message over REST and receive `message:created` on a WebSocket opened through Caddy.

## Dependencies

Web: `react-markdown@10.1.0`, `remark-gfm@4.0.1`, `zustand@5.0.15`. All three are already listed in PLAN.md; server needs no new ones.

## Risks

1. **Duplicate or misordered messages** across the optimistic copy, the REST response, the socket event and reconnect catch-up. Guarded by the normalized store (upsert by id, replace by nonce, order by id) and the no-duplicate assertions in scenarios 3 and 4.
2. **Offline/reconnect e2e flakiness** (socket.io backoff, `setOffline` semantics). Guarded by `reconnectionDelayMax: 2000` and `expect.poll` with a 10 s ceiling, and I'll check both hold up across the 3× repeat.
3. **DM privacy leaks** through a wrong audience. Guarded by the single `emitToChannel` path, a three-socket Vitest test and the e2e event-log assertion.
