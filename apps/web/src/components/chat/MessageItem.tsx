import { LIMITS, type Message, type PublicUser } from '@hearth/shared';
import { useState, type KeyboardEvent } from 'react';
import { deleteMessage, editMessage } from '../../api/chat';
import { errorMessage } from '../../api/errors';
import { useMessageStore, type PendingMessage } from '../../stores/messages';
import { deliverPending } from '../../lib/messageSync';
import { setReaction } from '../../lib/reactions';
import { Markdown } from '../Markdown';
import { inputClass } from '../styles';
import { AddReaction, ReactionBar } from './Reactions';

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

const iconButton =
  'flex items-center rounded px-1.5 py-0.5 text-muted ring-1 ring-white/10 transition hover:bg-white/10 ' +
  'hover:text-text focus-visible:outline-2 focus-visible:outline-accent';

export interface Viewer {
  id: string;
  username: string;
}

interface MessageItemProps {
  message: Message;
  authorName: string;
  me: Viewer;
  usersById: ReadonlyMap<string, PublicUser>;
  /** Lowercased usernames of active users (mention highlighting). */
  usernames: ReadonlySet<string>;
  /** Every DM message mentions the other member (B.5a rule 1), so DMs skip the mention highlight. */
  isDm: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** False in a read-only DM (the other member is deactivated). */
  canReact: boolean;
  onError: ErrorSink;
}

export function MessageItem({
  message,
  authorName,
  me,
  usersById,
  usernames,
  isDm,
  canEdit,
  canDelete,
  canReact,
  onError,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mentionsMe = message.mentionUserIds.includes(me.id);
  const highlight = mentionsMe && !isDm;

  const react = (emoji: string, add: boolean) => {
    onError(null);
    setReaction(message.channelId, message.id, emoji, me.id, add).catch((err: unknown) => {
      onError(errorMessage(err));
    });
  };

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
      data-mentions-me={mentionsMe ? 'true' : undefined}
      className={`group relative py-1.5 pr-4 hover:bg-white/[0.03] ${
        highlight ? 'border-l-2 border-accent bg-accent/[0.06] pl-[14px]' : 'pl-4'
      }`}
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
            <Markdown selfUsername={me.username} usernames={usernames}>
              {message.content}
            </Markdown>
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
      <ReactionBar
        message={message}
        meId={me.id}
        usersById={usersById}
        disabled={!canReact}
        onToggle={react}
      />
      {!editing && (canReact || canEdit || canDelete) && (
        <div className="absolute top-1 right-4 flex gap-1 rounded-md bg-surface-raised p-0.5 opacity-0 shadow ring-1 ring-white/10 transition group-focus-within:opacity-100 group-hover:opacity-100">
          {canReact && (
            <AddReaction
              className={iconButton}
              onPick={(emoji) => {
                react(emoji, true);
              }}
            />
          )}
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
  usernames,
  onError,
}: {
  pending: PendingMessage;
  authorName: string;
  usernames: ReadonlySet<string>;
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
        <Markdown usernames={usernames}>{pending.content}</Markdown>
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
