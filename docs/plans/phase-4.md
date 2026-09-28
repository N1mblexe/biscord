# Phase 4 plan — Presence, typing, unread, reactions, mentions, notifications

Status: **approved 2026-09-29**. Source: PLAN.md §3.3–3.6 and §5 Phase 4, CONTRACTS.md B.1, B.4 rows 12 and 24–26, B.5.
Starts only after Phase 3 is committed.

## Goal

The chat feels alive:

- You can see who's online and who's typing.
- Channels you haven't read stand out, and mentions get a count.
- Messages can take emoji reactions.
- `@username` highlights, and the browser notifies you about mentions and DMs while the tab is hidden.

No new tables are needed (`read_states`, `message_reactions` and `message_mentions` already exist from Phase 1) and no new dependencies.

## In scope

| Area          | Contract                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presence      | `presence {userId, online}` to `all`. `/bootstrap.onlineUserIds` goes live.                                                                         |
| Typing        | client→server `typing:start {channelId}` (ack), server→client `typing {channelId, userId}` to the channel audience except the sender                |
| Read state    | row 26 `POST /channels/:id/read`, `readstate:updated` to the sender's own sockets. `/bootstrap.readStates` goes live.                               |
| Reactions     | rows 24–25 PUT/DELETE `/messages/:id/reactions/:emoji`, `reaction:added`/`reaction:removed` to the channel audience. `Message.reactions` goes live. |
| Mentions      | server-side parsing on create and edit into `message_mentions`. `Message.mentionUserIds` goes live.                                                 |
| Notifications | browser `Notification` API for mentions and DMs while the tab is hidden (client only)                                                               |

## Contract clarifications (CONTRACTS.md, in the same commit)

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

## Key decisions

- **Server:**
  - `realtime/presence.ts`: an in-memory `Map<userId, Set<socketId>>` plus the grace-period timers, all cleaned up in `onClose` and on test reset.
  - `realtime/typing.ts`: the throttle map; handlers registered through the existing zod-validated `onClientEvent` wrapper.
  - `services/reads.ts`: the forward-only upsert, plus **one SQL query** that computes `ReadState[]` for every channel the user can access (text channels + own DMs). It feeds bootstrap.
  - `services/mentions.ts`: parse and store, inside the message create/edit transaction.
  - `services/reactions.ts`: insert/delete with the 20-distinct-emoji cap (`CONFLICT`) enforced under a row lock on the message; `Message` serialization aggregates reactions and mentions for a whole history page in one query each (no N+1).
- **Web:**
  - A zustand `presence` store (online ids) fed by bootstrap and `presence` events.
  - A `typing` store keyed by channel, with expiry timers.
  - A `reads` store (`ReadState` by channel) fed by bootstrap, `readstate:updated` and local `message:created`.
- **Unread logic (web):**
  - A `message:created` from someone else in a channel I'm not viewing, or while the tab is hidden, marks it unread. If `mentionUserIds` includes me, `mentionCount` goes up.
  - While I'm viewing a channel, scrolled to the bottom, with the tab visible, the client POSTs `read` with the newest id (debounced 500 ms).
  - Server `readstate:updated` events overwrite local guesses.
- **Mention rendering:** a local remark plugin (the same no-dependency style as the html→text plugin) splits text nodes on the mention regex into `span` elements with `data-testid="mention"` and `data-self="true"` when the mention is me. `span` is added to `allowedElements`.
- **Notifications:**
  - Settings gets a **Desktop notifications** checkbox that requests permission and stores the preference in `localStorage`.
  - A notification fires on a `message:created` that mentions me while `document.visibilityState === 'hidden'`, never for my own messages.
  - Title: `<author> in #channel` or `<author>` for a DM. Body: the first 120 characters of the plain text.
  - Clicking it focuses the window and navigates to the channel.

## Web UI contract (for parallel e2e work)

| Where     | Contract                                                                                                                                                                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presence  | `member-item` gets `data-online="true"`/`"false"` and a status dot. DM `channel-link`s get the same `data-online`.                                                                                                                                                                                                                                       |
| Typing    | `data-testid="typing-indicator"` above the composer: "Alice is typing…", "Alice and Bob are typing…", or "Several people are typing…". Absent when nobody is typing.                                                                                                                                                                                     |
| Unread    | `channel-link` gets `data-unread="true"`/`"false"` (bold when unread). With mentions, a child `data-testid="mention-badge"` holds the count. Absent at 0.                                                                                                                                                                                                |
| Reactions | Under each message, one `data-testid="reaction"` button per emoji: text `<emoji> <count>`, `aria-pressed` true when I reacted, click toggles. A button **Add reaction** (visible on hover, always in the DOM) opens `role="dialog"` named **Add reaction** with one button per palette emoji (`aria-label` = the emoji). Choosing one closes the dialog. |
| Mentions  | `span[data-testid="mention"]` inside `message-content`, with `data-self="true"` for me. A message that mentions me gets `data-mentions-me="true"` on its `message-item`.                                                                                                                                                                                 |
| Settings  | Checkbox **Desktop notifications**.                                                                                                                                                                                                                                                                                                                      |

## Execution (tech lead + subagents)

1. **Lead:** commit Phase 3; add contract clarifications 1–6 to CONTRACTS.md. No new shared schemas are expected, and any schema change goes in with them.
2. **Parallel:**
   - **server agent** (`apps/server/**`): presence, typing, reads, mentions, reactions, bootstrap wiring, serialization, Vitest.
   - **web agent** (`apps/web/**`): stores, sidebar/member indicators, typing indicator, reaction bar and palette, mention highlighting, notifications and settings toggle, unit tests.
   - **e2e agent** (`e2e/**`): the specs below, with a `Notification` stub and a hidden-tab helper.
3. **Fresh reviewer** → fix-up agent if needed → the lead runs acceptance (both modes, 3× repeat) → PROGRESS.md → commit `phase 4: …`.

## Acceptance tests

**Vitest (server, real DB):**

- **Presence:**
  - The first socket emits online. A second socket emits nothing.
  - Closing one of two sockets emits nothing. Closing the last one emits offline after the grace period.
  - Reconnecting within the grace period emits nothing.
  - Bootstrap lists online ids.
- **Typing:**
  - Delivered to the audience except the sender, across all of the sender's sockets; DM typing reaches only the other member.
  - Voice → `VALIDATION`. A non-member → `FORBIDDEN`.
  - The throttle drops repeats within 2 s.
- **Reads:**
  - Forward-only. A `messageId` from another channel → `VALIDATION`.
  - `unread` ignores my own messages. `mentionCount` is correct.
  - `readstate:updated` goes to my sockets only.
  - Sending moves my read state forward.
  - Bootstrap `readStates` covers text channels and my DMs only.
- **Mentions:**
  - Parse edge cases: `a@bob`, `@@bob`, an unknown user, a deactivated user, a self-mention, a DM non-member, duplicates, uppercase.
  - Editing recomputes. Every DM message mentions the other member.
- **Reactions:**
  - Idempotent PUT/DELETE, with events only on change.
  - The 21st distinct emoji → `CONFLICT`. An invalid emoji → `VALIDATION`.
  - A DM non-member → 403.
  - History pages aggregate reactions and mentions correctly, with the query count bounded (no N+1; asserted by counting queries).

**Playwright (dev-server mode):**

1. **Presence:** A sees B `data-online="true"`. B's context closes → within 5 s A sees `data-online="false"`.
2. **Typing:** A types in **Message** → B sees "Alice is typing…". A stops → the indicator disappears within about 6 s. A types again and sends → the indicator disappears immediately.
3. **Unread and mentions, synced across tabs:** B is on `#random` with a second tab. A posts in `#general` → B's `#general` link is `data-unread="true"` in both tabs. A posts `@bob hi` → `mention-badge` shows `1`. B opens `#general` in tab 1 → both tabs clear the unread flag and the badge.
4. **Reactions:** A adds 👍 through **Add reaction** → B sees `👍 1`. B clicks it → `👍 2` with `aria-pressed=true` for B. A clicks it → `👍 1`. Reloading keeps the state.
5. **Mentions and notifications:**
   - B has `Notification` stubbed (recording calls, permission `granted`), notifications enabled, and the tab set hidden.
   - A posts `@bob look` in `#general` → the stub records a notification titled `Alice in #general`, and B's message shows `span[data-testid="mention"][data-self="true"]`.
   - A DMs B → a second notification titled `Alice`.
   - A message without a mention → no notification.

**Full stack:** the `@smoke` specs, plus a manual check through Caddy: two sockets see each other's presence events, and a reaction PUT broadcasts.

## Risks

1. **Unread correctness across tabs and reconnects.** The server computes state in one tested query, and clients treat `readstate:updated` as authoritative and refetch bootstrap on reconnect (Phase 3's catch-up path).
2. **Presence flapping on reloads or brief drops.** Covered by the 3 s grace period, change-only emits, and tests for multiple sockets and the grace window.
3. **Notification testing in headless Chromium.** A stubbed `Notification` plus a forced `visibilityState`; the real permission prompt isn't tested.
