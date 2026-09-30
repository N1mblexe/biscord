import type { Message, PublicUser } from '@hearth/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { deleteMessage, editMessage } from '../../api/chat';
import { errorMessage } from '../../api/errors';
import { useMessageStore, type PendingMessage } from '../../stores/messages';
import { MESSAGE_INPUT_MAX_LENGTH, messageTooLong } from '../../lib/messageLength';
import { deliverPending } from '../../lib/messageSync';
import { setReaction } from '../../lib/reactions';
import { Avatar } from '../Avatar';
import { Markdown } from '../Markdown';
import { inputClass } from '../styles';
import { AttachmentList } from './Attachments';
import { AddReaction, ReactionBar } from './Reactions';
import { useAutoGrow } from './useAutoGrow';

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

/**
 * The hover toolbar: invisible and click-through (pointer-events-none) until the message is hovered
 * or holds focus, so a click on the author/time line never lands on an invisible Delete. Devices
 * without hover open it with the "⋯" button instead (`open`).
 */
function toolbarClass(open: boolean): string {
  const base = 'flex gap-1 rounded-md bg-surface-raised p-0.5 shadow ring-1 ring-white/10 transition';
  return open
    ? `${base} pointer-events-auto opacity-100`
    : `${base} pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100`;
}

const iconButton =
  'flex items-center rounded px-1.5 py-0.5 text-muted ring-1 ring-white/10 transition hover:bg-white/10 ' +
  'hover:text-text focus-visible:outline-2 focus-visible:outline-accent';

/** The touch-only "⋯" button: hidden where hover works (and hover shows the toolbar). */
const moreButton =
  'pointer-events-auto hidden items-center rounded bg-surface-raised px-1.5 py-0.5 text-muted ring-1 ' +
  'ring-white/10 hover-none:flex focus-visible:outline-2 focus-visible:outline-accent';

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
  // Touch (no hover): the toolbar is opened with the "⋯" button.
  const [actionsOpen, setActionsOpen] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // Set when an edit ends, so focus goes back to this message's Edit button once it is rendered.
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = editButtonRef.current ?? document.getElementById('composer-input');
    target?.focus();
  }, [editing]);

  // A tap anywhere outside this message closes its touch toolbar.
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && itemRef.current?.contains(event.target)) return;
      setActionsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [actionsOpen]);
  const author = usersById.get(message.authorId);
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
      ref={itemRef}
      data-testid="message-item"
      data-message-id={message.id}
      data-mentions-me={mentionsMe ? 'true' : undefined}
      className={`group relative flex gap-3 py-1.5 pr-4 hover:bg-white/[0.03] ${
        highlight ? 'border-l-2 border-accent bg-accent/[0.06] pl-[14px]' : 'pl-4'
      }`}
    >
      <div className="pt-0.5">
        <Avatar
          userId={message.authorId}
          name={authorName}
          avatarUrl={author?.avatarUrl ?? null}
          deleted={author?.deactivated === true}
        />
      </div>
      <div className="min-w-0 flex-1">
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
              restoreFocus.current = true;
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
        <AttachmentList attachments={message.attachments} />
        <ReactionBar
          message={message}
          meId={me.id}
          usersById={usersById}
          disabled={!canReact}
          onToggle={react}
        />
      </div>
      {!editing && (canReact || canEdit || canDelete) && (
        // The wrapper never takes clicks itself (only the visible toolbar and the "⋯" button do).
        <div className="pointer-events-none absolute top-1 right-4 flex items-start gap-1">
          <div className={toolbarClass(actionsOpen)}>
            {canReact && (
              <AddReaction
                className={iconButton}
                onPick={(emoji) => {
                  setActionsOpen(false);
                  react(emoji, true);
                }}
              />
            )}
            {canEdit && (
              <button
                ref={editButtonRef}
                type="button"
                className={actionButton}
                onClick={() => {
                  onError(null);
                  setActionsOpen(false);
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
                  setActionsOpen(false);
                  void onDelete();
                }}
              >
                Delete
              </button>
            )}
          </div>
          {/* Only on devices without hover (display:none elsewhere, so not in the a11y tree). */}
          <button
            type="button"
            aria-label="Message actions"
            title="Message actions"
            aria-expanded={actionsOpen}
            className={moreButton}
            onClick={(event) => {
              if (actionsOpen) event.currentTarget.blur();
              setActionsOpen(!actionsOpen);
            }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, draft);

  const save = async () => {
    if (saving) return;
    const content = draft.trim();
    if (content === message.content) {
      onDone();
      return;
    }
    const tooLong = messageTooLong(content);
    if (tooLong !== null) {
      onError(tooLong);
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
        ref={inputRef}
        aria-label="Edit message"
        className={`${inputClass} max-h-64 resize-none`}
        rows={2}
        maxLength={MESSAGE_INPUT_MAX_LENGTH}
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
  authorAvatarUrl,
  usernames,
  onError,
}: {
  pending: PendingMessage;
  authorName: string;
  authorAvatarUrl: string | null;
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
      className="flex gap-3 px-4 py-1.5"
    >
      <div className="pt-0.5">
        <Avatar userId={pending.authorId} name={authorName} avatarUrl={authorAvatarUrl} />
      </div>
      <div className="min-w-0 flex-1">
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
        <div className={failed ? '' : 'opacity-60'}>
          <AttachmentList attachments={pending.attachments} />
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
      </div>
    </li>
  );
}
