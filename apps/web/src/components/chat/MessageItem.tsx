import { LIMITS, type Message } from '@hearth/shared';
import { useState, type KeyboardEvent } from 'react';
import { deleteMessage, editMessage } from '../../api/chat';
import { errorMessage } from '../../api/errors';
import { useMessageStore, type PendingMessage } from '../../stores/messages';
import { deliverPending } from '../../lib/messageSync';
import { Markdown } from '../Markdown';
import { inputClass } from '../styles';

const actionButton =
  'rounded px-2 py-0.5 text-xs font-medium text-muted ring-1 ring-white/10 transition hover:bg-white/10 ' +
  'hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

type ErrorSink = (message: string | null) => void;

interface MessageItemProps {
  message: Message;
  authorName: string;
  canEdit: boolean;
  canDelete: boolean;
  onError: ErrorSink;
}

export function MessageItem({ message, authorName, canEdit, canDelete, onError }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const onDelete = async () => {
    if (!window.confirm('Delete this message?')) return;
    onError(null);
    setBusy(true);
    try {
      await deleteMessage(message.id);
      useMessageStore.getState().remove(message.channelId, message.id);
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <li
      data-testid="message-item"
      data-message-id={message.id}
      className="group relative px-4 py-1.5 hover:bg-white/[0.03]"
    >
      <div className="flex items-baseline gap-2">
        <span data-testid="message-author" className="text-sm font-semibold">
          {authorName}
        </span>
        <time
          dateTime={message.createdAt}
          title={formatFull(message.createdAt)}
          className="text-xs text-muted"
        >
          {formatTime(message.createdAt)}
        </time>
      </div>
      {editing ? (
        <EditForm
          message={message}
          onDone={() => {
            setEditing(false);
          }}
          onError={onError}
        />
      ) : (
        <div className="text-sm leading-relaxed">
          <div data-testid="message-content" className="markdown break-words">
            <Markdown>{message.content}</Markdown>
          </div>
          {message.editedAt && (
            <span
              data-testid="message-edited"
              title={formatFull(message.editedAt)}
              className="text-[11px] text-muted"
            >
              (edited)
            </span>
          )}
        </div>
      )}
      {!editing && (canEdit || canDelete) && (
        <div className="absolute top-1 right-4 flex gap-1 rounded-md bg-surface-raised p-0.5 opacity-0 shadow ring-1 ring-white/10 transition group-focus-within:opacity-100 group-hover:opacity-100">
          {canEdit && (
            <button
              type="button"
              className={actionButton}
              onClick={() => {
                onError(null);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className={`${actionButton} hover:text-danger`}
              disabled={busy}
              onClick={() => {
                void onDelete();
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function EditForm({
  message,
  onDone,
  onError,
}: {
  message: Message;
  onDone: () => void;
  onError: ErrorSink;
}) {
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    const content = draft.trim();
    if (content === message.content) {
      onDone();
      return;
    }
    onError(null);
    setSaving(true);
    try {
      const updated = await editMessage(message.id, content);
      useMessageStore.getState().updateIfPresent(updated);
      onDone();
    } catch (err) {
      onError(errorMessage(err));
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDone();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <form
      className="mt-1 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        aria-label="Edit message"
        className={`${inputClass} resize-none`}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        maxLength={LIMITS.messageMaxChars}
        value={draft}
        autoFocus
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-2 text-xs text-muted">
        <button type="submit" className={actionButton} disabled={saving}>
          Save
        </button>
        <button type="button" className={actionButton} onClick={onDone}>
          Cancel
        </button>
        <span>Enter to save · Escape to cancel</span>
      </div>
    </form>
  );
}

export function PendingItem({
  pending,
  authorName,
  onError,
}: {
  pending: PendingMessage;
  authorName: string;
  onError: ErrorSink;
}) {
  const failed = pending.status === 'failed';
  const retry = () => {
    onError(null);
    deliverPending(pending.nonce).catch((err: unknown) => {
      onError(errorMessage(err));
    });
  };

  return (
    <li
      data-testid="message-item"
      data-pending="true"
      data-failed={failed ? 'true' : undefined}
      className="px-4 py-1.5"
    >
      <div className="flex items-baseline gap-2">
        <span data-testid="message-author" className="text-sm font-semibold">
          {authorName}
        </span>
        <span className="text-xs text-muted">{failed ? 'Not sent' : 'Sending…'}</span>
      </div>
      <div
        data-testid="message-content"
        className={`markdown text-sm break-words ${failed ? 'text-danger/80' : 'opacity-60'}`}
      >
        <Markdown>{pending.content}</Markdown>
      </div>
      {failed && (
        <div className="mt-1 flex gap-1">
          <button type="button" className={actionButton} onClick={retry}>
            Retry
          </button>
          <button
            type="button"
            className={actionButton}
            onClick={() => {
              useMessageStore.getState().discardPending(pending.nonce);
            }}
          >
            Discard
          </button>
        </div>
      )}
    </li>
  );
}
