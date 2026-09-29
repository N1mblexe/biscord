import { LIMITS } from '@hearth/shared';
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { errorMessage } from '../../api/errors';
import { formatBytes, isUploading, readyAttachments, type Chip } from '../../lib/attachments';
import { deliverPending } from '../../lib/messageSync';
import { emitTyping, resetTypingThrottle } from '../../lib/typingEmit';
import { useSocket } from '../../socket/context';
import { useMessageStore } from '../../stores/messages';
import { inputClass, primaryButton } from '../styles';
import type { AttachmentUploads } from './useAttachmentUploads';

interface ComposerProps {
  channelId: string;
  authorId: string;
  placeholder: string;
  /** Set when the channel can't be posted to (a DM with a deactivated user); shown as the placeholder. */
  disabledReason: string | null;
  /** Pending attachments; owned by the channel view so drops anywhere on it land here. */
  uploads: AttachmentUploads;
  onError: (message: string | null) => void;
}

/**
 * Message box: Enter sends, Shift+Enter adds a newline. Sends are optimistic (pending by nonce).
 * Typing announces `typing:start` (throttled, lib/typingEmit.ts). Files come from the paperclip
 * (**Attach files**), a paste, or a drop on the channel view; each is an `attachment-chip`, and
 * **Send** is disabled while any of them is still uploading. A message may be files only.
 */
export function Composer({
  channelId,
  authorId,
  placeholder,
  disabledReason,
  uploads,
  onError,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const { socket } = useSocket();
  const disabled = disabledReason !== null;
  const { chips, addFiles, remove, markSent } = uploads;
  const uploading = isUploading(chips);

  const send = () => {
    const content = draft.trim();
    const attachments = readyAttachments(chips);
    if (disabled || uploading || (content.length === 0 && attachments.length === 0)) return;
    if (content.length > LIMITS.messageMaxChars) {
      onError(`Messages can be at most ${LIMITS.messageMaxChars} characters.`);
      return;
    }
    onError(null);
    const nonce = crypto.randomUUID();
    useMessageStore.getState().addPending({
      nonce,
      channelId,
      authorId,
      content,
      attachments,
      createdAt: new Date().toISOString(),
    });
    setDraft('');
    // The files now travel with the pending message (a failed send keeps them for Retry).
    markSent(chips.filter((c) => c.state === 'ready').map((c) => c.key));
    resetTypingThrottle(channelId);
    deliverPending(nonce).catch((err: unknown) => {
      onError(errorMessage(err));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <form
      className="border-t border-white/5 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      {chips.length > 0 && (
        <ul aria-label="Attachments" className="mb-2 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <AttachmentChip
              key={chip.key}
              chip={chip}
              onRemove={() => {
                remove(chip.key);
              }}
            />
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <input
          id="composer-files"
          type="file"
          multiple
          className="peer sr-only"
          disabled={disabled}
          onChange={(event) => {
            const input = event.currentTarget;
            addFiles(Array.from(input.files ?? []));
            // Lets the same file be picked again.
            input.value = '';
          }}
        />
        <label
          htmlFor="composer-files"
          title="Attach files"
          className={`flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted ring-1 ring-white/10 transition hover:bg-white/10 hover:text-text peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
            disabled ? 'pointer-events-none opacity-60' : ''
          }`}
        >
          <PaperclipIcon />
          <span className="sr-only">Attach files</span>
        </label>
        <textarea
          id="composer-input"
          name="content"
          className={`${inputClass} max-h-48 resize-none`}
          rows={Math.min(8, draft.split('\n').length)}
          maxLength={LIMITS.messageMaxChars}
          placeholder={disabledReason ?? placeholder}
          disabled={disabled}
          value={draft}
          // Focus follows the channel the user just opened.
          autoFocus
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            if (value.trim().length > 0) emitTyping(socket, channelId);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button type="submit" className={primaryButton} disabled={disabled || uploading}>
          Send
        </button>
      </div>
    </form>
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none">
      <path
        d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.5 11a1.1 1.1 0 0 1-1.5-1.5L10 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const CHIP_TONE: Record<Chip['state'], string> = {
  uploading: 'text-muted ring-white/10',
  ready: 'text-text ring-white/15',
  failed: 'text-danger ring-danger/40',
};

const CHIP_STATUS: Record<Chip['state'], string> = {
  uploading: 'Uploading…',
  ready: '',
  failed: 'Failed',
};

/** One pending file: `attachment-chip` with `data-state` and a **Remove <filename>** button. */
function AttachmentChip({ chip, onRemove }: { chip: Chip; onRemove: () => void }) {
  const status = CHIP_STATUS[chip.state];
  return (
    <li
      data-testid="attachment-chip"
      data-state={chip.state}
      aria-busy={chip.state === 'uploading' ? true : undefined}
      className={`flex max-w-64 items-center gap-2 rounded-lg bg-surface-raised py-1 pr-1 pl-3 text-xs ring-1 ${CHIP_TONE[chip.state]}`}
    >
      <span className="min-w-0 truncate" title={chip.filename}>
        {chip.filename}
      </span>
      <span className="shrink-0 text-muted">{status || formatBytes(chip.sizeBytes)}</span>
      <button
        type="button"
        aria-label={`Remove ${chip.filename}`}
        title={`Remove ${chip.filename}`}
        className="shrink-0 rounded px-1.5 text-sm leading-5 text-muted hover:bg-white/10 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        onClick={onRemove}
      >
        ×
      </button>
    </li>
  );
}
