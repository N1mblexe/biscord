# Phase 5 plan — Uploads & avatars

Status: **done 2026-09-29** (see PROGRESS.md; plan approved 2026-09-29; no per-user storage quota in v1; Phase 8 candidate). Source: PLAN.md §3.1, §3.7, §5 Phase 5 and §6, CONTRACTS.md B.1 (`attachments`, `users.avatar_key`), B.4 rows 10, 11, 14, 27 and 28, B.7 (upload lifecycle), B.8 (`UPLOAD_DIR`).
Starts only after Phase 4 is committed.

## Goal

People can share files and set an avatar, safely:

- Any file up to 25 MB can be attached to a message.
- png/jpeg/gif/webp images preview inline; everything else downloads.
- Files are readable only by people who can see the message.
- An avatar change shows up everywhere without a reload.
- An upload that fails midway leaves no row and no file.
- Disk usage stays bounded by garbage collection (GC).

## In scope

| Area        | Contract                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attachments | row 27 `POST /attachments` (multipart, unattached); row 28 `GET /attachments/:id/:filename`; `Message.attachments` goes live; send (row 21) already claims `attachmentIds` in its transaction (Phase 3) |
| Deletion    | B.7: message and channel delete collect storage keys in the transaction and unlink them after commit (the `TODO(phase 5)` markers in `services/messages.ts` and `services/channels.ts`)                 |
| Avatars     | row 10 `PUT /me/avatar`, row 11 `DELETE /me/avatar`, row 14 `GET /avatars/:userId`; `PublicUser.avatarUrl` goes live; `user:updated` on change                                                          |
| GC          | Unattached rows and files older than 24 h, temp files older than 1 h, orphan files on disk (attachments and avatars no row points to)                                                                   |
| Carry-over  | PROGRESS.md known issue: a relative `UPLOAD_DIR` resolved against `apps/server/` in dev                                                                                                                 |

## Contract changes (CONTRACTS.md + shared, in the same commit)

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

## Key decisions

- **Streaming upload** (`storage/files.ts`, verified against the `@fastify/multipart@10.1.2` and `file-type@22.1.1` type definitions):
  1. `request.file({ limits: { fileSize: LIMITS.uploadMaxBytes, files: 1, fields: 0, parts: 1 } })`.
  2. `pipeline(part.file, fs.createWriteStream(tmpPath, { flags: 'wx' }))`. Because `throwFileSizeLimit` defaults to `true`, crossing the byte cap rejects the pipeline with `RequestFileTooLargeError`, which maps to 413.
  3. `fileTypeFromFile(tmpPath)` sniffs the magic bytes (the multipart stream is consumed, so the file is sniffed after writing, never buffered).
  4. `rename` into the final key (same filesystem), then insert the row.
  - A `finally` guard unlinks the temp file on **any** failure: abort, overflow, sniff error or DB error.
- **Path safety:** a single `resolveKey(key)` does `path.resolve(root, key)` and asserts the result is inside `root`; every read and unlink goes through it. Keys match `^(\d{4}/\d{2}|avatars|tmp)/[0-9a-f-]{36}$`.
- **Access:** `GET /attachments` reuses Phase 3's `loadChannelForUser` on the message's channel. Unattached files are readable only by their uploader. Files stream with `fs.createReadStream` (no Range support in v1).
- **Serialization:** a history page loads attachments for all its messages in **one** query (the same pattern as Phase 4 reactions). `url` = `/api/attachments/<id>/<encodeURIComponent(filename)>`, and `inline` = the mime type is in the allowlist.
- **Rate limits and caps:**
  - Uploads: 20 per minute per user, keyed by user id like message sends.
  - Caddy `request_body max_size 26MB` stays just above the server cap, so the server's JSON 413 is what normally fires.
  - The route `bodyLimit` isn't involved, because multipart streams.
- **GC** (`storage/gc.ts`):
  - `runGc({ now })` is a pure function that the Vitest tests call directly.
  - A scheduler started in `onReady` runs it every `UPLOAD_GC_INTERVAL_MINUTES` (with `unref()`) and stops in `onClose`.
  - An advisory lock prevents overlapping runs.
  - Each run: unattached rows older than 24 h (row then file), temp files older than 1 h, and a walk of `yyyy/mm/` and `avatars/` for files older than 24 h that no row references.
  - The test reset also empties `UPLOAD_DIR`.
- **Web:**
  - Uploads use `XMLHttpRequest` for progress events (no dependency), with the CSRF header.
  - A client-side 25 MB pre-check shows an error before uploading.
  - Up to 10 chips per message; Send is disabled while any upload is in flight; drag-drop onto the chat pane and pasting images both attach.
  - Inline images are lazy-loaded with a max display size, and clicking one opens the original in a new tab. Other files show as a download link with name and size.
  - An `Avatar` component (image, or initials as a fallback) is used in message authors, the members panel, DM links and the header.

## Web UI contract (for parallel e2e work)

| Where    | Contract                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer | File input labelled **Attach files** (`multiple`) behind a paperclip button. Each pending file is a `data-testid="attachment-chip"` with its filename, `data-state="uploading"`/`"ready"`/`"failed"`, and a button **Remove <filename>**. **Send** is disabled while a chip is uploading. A file over 25 MB shows the page alert `File is too large (max 25 MB).` and is not uploaded. |
| Message  | Inline images: `img[data-testid="attachment-image"]` with `alt` = filename, wrapped in a link to the file URL (`target="_blank"`). Other files: `a[data-testid="attachment-file"]` with text `<filename> (<size>)`, `href` = the file URL, and the `download` attribute.                                                                                                               |
| Avatars  | `data-testid="avatar"` on every avatar: an `img` whose `src` is the `avatarUrl`, or a `span` with initials. Used in `message-item` (author), `member-item`, DM `channel-link` and the header.                                                                                                                                                                                          |
| Settings | Section **Avatar**: file input labelled **Avatar**, button **Remove avatar** (only when set), and a `role="status"` success message `Avatar updated.` / `Avatar removed.`. An unsupported type shows the alert `Avatar must be a PNG, JPEG or WebP image.`                                                                                                                             |

## Execution (tech lead + subagents)

1. **Lead:**
   - Commit Phase 4.
   - Add server deps `@fastify/multipart@10.1.2` and `file-type@22.1.1` (both listed in PLAN.md).
   - Contract changes 1–7 in CONTRACTS.md and `.env.example`, plus any shared schema tweaks.
   - Carry over the `.dockerignore`/compose check: the uploads volume is already mounted at `/data/uploads`.
2. **Parallel:**
   - **server agent** (`apps/server/**`): storage, routes, serialization, deletion unlink, GC and scheduler, `UPLOAD_DIR` resolution, Vitest.
   - **web agent** (`apps/web/**`): upload client, composer chips, drag-drop and paste, attachment rendering, `Avatar`, settings section, 413 mapping, unit tests.
   - **e2e agent** (`e2e/**`): the specs below, generating fixture files in-test (a tiny PNG, a minimal PDF, an HTML/SVG file, a 26 MB buffer). No binary fixtures are committed.
3. **Fresh reviewer** (security-focused) → fix-up agent → the lead runs acceptance (both modes, 3× repeat) → PROGRESS.md → commit `phase 5: …`.

## Acceptance tests

**Vitest (server, real DB, `UPLOAD_DIR` in a per-run temp dir):**

- **Upload happy path:** 201; the row is unattached; the file is at `yyyy/mm/<uuid>`; the sniffed type overrides the declared one (a PNG sent as `text/plain` is stored as `image/png`).
- **Limits:** 25 MB + 1 byte → 413 and the temp dir is empty; 0 bytes → `VALIDATION`; two files or an extra field → `VALIDATION`; the 21st upload in a minute → 429.
- **Aborted upload:** a raw `http.request` sends half a multipart body, then `destroy()`. Poll until the temp dir is empty, and assert **no row, no file**.
- **Filenames:** sanitization cases (`../../etc/passwd`, `a\b.txt`, control characters, 300-byte UTF-8), and the `Content-Disposition` encoding round-trips for a non-ASCII name.
- **Serving:**
  - inline for png/jpeg/gif/webp; `attachment` + `application/octet-stream` for SVG, HTML and unknown types;
  - `nosniff` and CSP headers are present;
  - anonymous → 401; a DM non-member or someone else's unattached upload → 404.
- **Sending:** a message with attachments serializes them (one query per page, asserted by counting queries); claiming someone else's upload → `VALIDATION`.
- **Deletion:** deleting a message or a text channel unlinks its files after commit; an unlink failure is logged, not thrown.
- **Avatars:**
  - set, replace (old file unlinked, `v` changes) and delete;
  - a gif or svg → 415, over 2 MB → 413;
  - `user:updated` is broadcast;
  - GET returns the cache header, or 404 when unset.
- **GC:** with `now` injected, old unattached rows and files, old temp files and orphan files are removed; fresh and attached ones are kept; overlapping runs are serialized.
- **`UPLOAD_DIR`:** a relative path resolves against the repo root.

**Playwright (dev-server mode):**

1. A attaches a generated PNG and a PDF plus text and sends. B sees `attachment-image` (its `naturalWidth > 0`) and an `attachment-file` link showing `report.pdf`. B's `request.get(href)` for the PDF returns 200 with `content-disposition` starting `attachment` and `nosniff`.
2. Selecting a 26 MB file in the UI shows `File is too large (max 25 MB).` with no network upload. Posting 26 MB straight to `POST /api/attachments` gets 413 `PAYLOAD_TOO_LARGE`.
3. An anonymous request for the file URL gets 401. A's attachment in an A↔B DM gets 404 for C.
4. An uploaded `evil.svg` and `evil.html` render as download links, never as `img`/iframe, and serve as `attachment`.
5. A sets an avatar in Settings. B's `member-item` `avatar` `src` changes to the new `?v=` without a reload. A removes it and B sees initials.

**Full stack:**

- The `@smoke` specs.
- A manual check through Caddy: a 5 MB upload succeeds, a 27 MB upload gets 413 (Caddy's cap, mapped by the client), and the file survives `docker compose restart server` (the volume persists).

## Dependencies

Server: `@fastify/multipart@10.1.2` and `file-type@22.1.1` (ESM, Node ≥ 22). Both are already in PLAN.md. The web app needs none.

## Risks

1. **Stored XSS through uploaded content** (HTML/SVG, or type confusion). Covered by sniff-not-trust, the inline allowlist, `attachment` disposition, `nosniff`, a sandbox CSP on every file response, and e2e scenario 4.
2. **Partial writes and orphans filling the disk.** Covered by temp+rename with a `finally` unlink, post-commit unlinks, the GC (including an orphan walk), and the aborted-upload test. The 25 MB × 20/min per user rate still allows about 30 GB per user per hour in the worst case, so a per-user storage quota is noted as a Phase 8 hardening candidate.
3. **Path traversal or key injection.** Covered by server-generated keys, the key regex, and a `resolveKey` containment check on every file operation.
