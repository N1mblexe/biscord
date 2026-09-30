import { INLINE_IMAGE_MIME_TYPES, LIMITS, type Attachment } from '@hearth/shared';
import { errorMessage, UPLOAD_ERROR_MESSAGES } from '../api/errors';
import { formatBytes } from '../i18n/format';

// ---- Display ----

/** Human-readable size (`1.5 KB`) in the UI language; see `i18n/format.ts`. */
export { formatBytes };

const INLINE_TYPES: ReadonlySet<string> = new Set(INLINE_IMAGE_MIME_TYPES);

/** Where attachment files are served from (CONTRACTS `Attachment.url`). */
const ATTACHMENT_URL_PREFIX = '/api/attachments/';

export type AttachmentView = 'image' | 'file';

/**
 * How a message shows an attachment: an inline image only when the server serves it inline and its
 * type is on the inline allowlist (defence in depth); everything else is a download link.
 */
export function attachmentView(attachment: Pick<Attachment, 'inline' | 'mimeType'>): AttachmentView {
  return attachment.inline && INLINE_TYPES.has(attachment.mimeType) ? 'image' : 'file';
}

/** Only same-origin attachment URLs are ever linked or loaded. */
export function isAttachmentUrl(url: string): boolean {
  return url.startsWith(ATTACHMENT_URL_PREFIX);
}

/** The download link's text: `<filename> (<size>)`. */
export function fileLabel(attachment: Pick<Attachment, 'filename' | 'sizeBytes'>): string {
  return `${attachment.filename} (${formatBytes(attachment.sizeBytes)})`;
}

// ---- Composer chips ----

export const FILE_TOO_LARGE_MESSAGE = 'File is too large (max 25 MB).';
export const TOO_MANY_FILES_MESSAGE = `You can attach at most ${LIMITS.attachmentsPerMessage} files to a message.`;

/** The page alert for a failed attachment upload (POST /attachments). */
export function attachmentUploadError(err: unknown): string {
  return errorMessage(err, { ...UPLOAD_ERROR_MESSAGES, PAYLOAD_TOO_LARGE: FILE_TOO_LARGE_MESSAGE });
}

export type ChipState = 'uploading' | 'ready' | 'failed';

export interface Chip {
  /** Client-side key (the upload has no id until it succeeds). */
  key: string;
  filename: string;
  sizeBytes: number;
  state: ChipState;
  /** Set once the upload succeeded (`state === 'ready'`). */
  attachment: Attachment | null;
}

export type ChipAction =
  | { type: 'add'; chips: readonly { key: string; filename: string; sizeBytes: number }[] }
  | { type: 'ready'; key: string; attachment: Attachment }
  | { type: 'failed'; key: string }
  | { type: 'remove'; key: string }
  /** Drops the chips that went out with a message. */
  | { type: 'sent'; keys: readonly string[] };

/** The composer's pending attachments. Unknown keys are ignored (e.g. an upload finishing after Remove). */
export function chipsReducer(chips: readonly Chip[], action: ChipAction): readonly Chip[] {
  switch (action.type) {
    case 'add': {
      const room = LIMITS.attachmentsPerMessage - chips.length;
      if (room <= 0 || action.chips.length === 0) return chips;
      const added = action.chips
        .slice(0, room)
        .map((c): Chip => ({ ...c, state: 'uploading', attachment: null }));
      return [...chips, ...added];
    }
    case 'ready':
      return chips.map((c) =>
        c.key === action.key && c.state === 'uploading'
          ? { ...c, state: 'ready', attachment: action.attachment }
          : c,
      );
    case 'failed':
      return chips.map((c) =>
        c.key === action.key && c.state === 'uploading' ? { ...c, state: 'failed' } : c,
      );
    case 'remove': {
      const next = chips.filter((c) => c.key !== action.key);
      return next.length === chips.length ? chips : next;
    }
    case 'sent': {
      const keys = new Set(action.keys);
      const next = chips.filter((c) => !keys.has(c.key));
      return next.length === chips.length ? chips : next;
    }
  }
}

/** Send stays disabled while any upload is in flight. */
export function isUploading(chips: readonly Chip[]): boolean {
  return chips.some((c) => c.state === 'uploading');
}

/** The uploaded attachments a send would claim, in chip order. */
export function readyAttachments(chips: readonly Chip[]): Attachment[] {
  return chips.flatMap((c) => (c.state === 'ready' && c.attachment ? [c.attachment] : []));
}

export interface SelectedFile {
  name: string;
  size: number;
}

/**
 * Client-side pre-check before uploading: files over 25 MB are rejected, and only as many as fit
 * under the per-message cap (counting the chips already there) are accepted. `error` is the page
 * alert to show, the too-large message first.
 */
export function selectFiles<F extends SelectedFile>(
  existing: number,
  files: readonly F[],
): { accepted: F[]; error: string | null } {
  const fitting = files.filter((f) => f.size <= LIMITS.uploadMaxBytes);
  const room = Math.max(0, LIMITS.attachmentsPerMessage - existing);
  const accepted = fitting.slice(0, room);
  const error =
    fitting.length < files.length
      ? FILE_TOO_LARGE_MESSAGE
      : accepted.length < fitting.length
        ? TOO_MANY_FILES_MESSAGE
        : null;
  return { accepted, error };
}
