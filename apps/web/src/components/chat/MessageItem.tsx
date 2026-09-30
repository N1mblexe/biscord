import type { Message, PublicUser } from '@hearth/shared';
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
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
 * The hover toolbar: invisible and click-through (pointer-events-none) until the message is hovered,
 * has keyboard focus (on itself or inside), or has a popup open (the reaction palette), so a click on
 * the author/time line never lands on an invisible Delete. Enter/Space on the message and, on devices
 * without hover, the "⋯" button open it too (`open`).
 */
function toolbarClass(open: boolean): string {
  const base = 'flex gap-1 rounded-md bg-surface-raised p-0.5 shadow ring-1 ring-white/10 transition';
  return open
    ? `${base} pointer-events-auto opacity-100`
    : `${base} pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 ` +
        'group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 ' +
        'group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 ' +
        'group-has-[[aria-expanded=true]]:pointer-events-auto group-has-[[aria-expanded=true]]:opacity-100';
}

/** Shown in a grouped message's avatar column while it is hovered or focused (never adds height). */
const gutterTime =
  'absolute top-1 right-0 text-[10px] leading-4 whitespace-nowrap text-muted tabular-nums opacity-0 group-hover:opacity-100 ' +
  'group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100';

/** The message `<li>` before (`-1`) or after (`1`) `item`, skipping day separators and pending sends. */
function siblingMessage(item: HTMLElement | null, direction: -1 | 1): HTMLElement | null {
  let node = direction < 0 ? item?.previousElementSibling : item?.nextElementSibling;
  while (node) {
    if (node instanceof HTMLElement && node.dataset.messageId !== undefined) return node;
    node = direction < 0 ? node.previousElementSibling : node.nextElementSibling;
  }
  return null;
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
  /**
   * Follows a message by the same author within 5 minutes (lib/chatTimeline.ts): no avatar and no
   * visible author line (`message-author` stays in the DOM, visually hidden).
   */
  grouped: boolean;
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
  grouped,
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
  // Opened with Enter/Space on the message, or the "⋯" button (touch devices).
  const [actionsOpen, setActionsOpen] = useState(false);
  // Keyboard: the actions are out of the tab order until focus is inside this message, so the
  // history has one tab stop per message (the message itself) instead of three.
  const [focusWithin, setFocusWithin] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
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
  const hasActions = !editing && (canReact || canEdit || canDelete);
  const actionTabIndex = focusWithin || actionsOpen ? 0 : -1;

  /** Opens the toolbar and moves focus to its first action (keyboard). */
  const openActions = () => {
    setActionsOpen(true);
    toolbarRef.current?.querySelector('button')?.focus();
  };

  const onItemKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (target === event.currentTarget) {
      if ((event.key === 'Enter' || event.key === ' ') && hasActions) {
        event.preventDefault();
        openActions();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const next = siblingMessage(event.currentTarget, event.key === 'ArrowUp' ? -1 : 1);
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }
      return;
    }
    // Escape in the toolbar (not in the reaction palette, which closes itself) goes back to the message.
    if (
      event.key === 'Escape' &&
      target instanceof Element &&
      toolbarRef.current?.contains(target) === true &&
      target.closest('dialog') === null
    ) {
      event.preventDefault();
      setActionsOpen(false);
      itemRef.current?.focus();
    }
  };

  const onItemBlur = (event: FocusEvent<HTMLLIElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
    setActionsOpen(false);
  };

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
    // Focus moves to the neighbouring message (or the composer) instead of getting lost on <body>.
    const item = itemRef.current;
    const hadFocus = item?.contains(document.activeElement) ?? false;
    try {
      await deleteMessage(message.id);
      const neighbour = siblingMessage(item, 1) ?? siblingMessage(item, -1);
      useMessageStore.getState().remove(message.channelId, message.id);
      if (hadFocus) (neighbour ?? document.getElementById('composer-input'))?.focus();
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
      data-grouped={grouped ? 'true' : undefined}
      tabIndex={0}
      aria-keyshortcuts={hasActions ? 'Enter' : undefined}
      onFocus={() => {
        setFocusWithin(true);
      }}
      onBlur={onItemBlur}
      onKeyDown={onItemKeyDown}
      className={`group relative flex gap-3 pr-4 outline-accent hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 ${
        grouped ? 'py-0.5' : 'mt-1.5 pt-1 pb-0.5'
      } ${highlight ? 'border-l-2 border-accent bg-accent/[0.06] pl-[14px]' : 'pl-4'}`}
    >
      {grouped ? (
        <div className="relative w-9 shrink-0">
          <time dateTime={message.createdAt} title={formatFull(message.createdAt)} className={gutterTime}>
            {formatTime(message.createdAt)}
          </time>
        </div>
      ) : (
        <div className="pt-0.5">
          <Avatar
            userId={message.authorId}
            name={authorName}
            avatarUrl={author?.avatarUrl ?? null}
            deleted={author?.deactivated === true}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {grouped ? (
          <span data-testid="message-author" className="sr-only">
            {authorName}
          </span>
        ) : (
          <div className="flex min-w-0 items-baseline gap-2">
            {/* A long display name truncates instead of wrapping and pushing the time onto two lines. */}
            <span
              data-testid="message-author"
              className="min-w-0 truncate text-sm font-semibold"
              title={authorName}
            >
              {authorName}
            </span>
            <time
              dateTime={message.createdAt}
              title={formatFull(message.createdAt)}
              className="shrink-0 text-xs whitespace-nowrap text-muted"
            >
              {formatTime(message.createdAt)}
            </time>
          </div>
        )}
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
      {hasActions && (
        // The wrapper never takes clicks itself (only the visible toolbar and the "⋯" button do).
        <div className="pointer-events-none absolute top-1 right-4 flex items-start gap-1">
          <div ref={toolbarRef} className={toolbarClass(actionsOpen)}>
            {canReact && (
              <AddReaction
                className={iconButton}
                tabIndex={actionTabIndex}
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
                tabIndex={actionTabIndex}
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
                tabIndex={actionTabIndex}
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
            tabIndex={actionTabIndex}
            className={moreButton}
            onClick={(event) => {
              if (actionsOpen) {
                event.currentTarget.blur();
                setActionsOpen(false);
              } else if (event.detail === 0) {
                openActions(); // Enter/Space: straight to the first action
              } else {
                setActionsOpen(true);
              }
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
  grouped,
  usernames,
  onError,
}: {
  pending: PendingMessage;
  authorName: string;
  authorAvatarUrl: string | null;
  /** Follows our own message within 5 minutes: drawn like a grouped `MessageItem`. */
  grouped: boolean;
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
      data-grouped={grouped ? 'true' : undefined}
      className={`flex gap-3 px-4 ${grouped ? 'py-0.5' : 'mt-1.5 pt-1 pb-0.5'}`}
    >
      {grouped ? (
        <div className="w-9 shrink-0" />
      ) : (
        <div className="pt-0.5">
          <Avatar userId={pending.authorId} name={authorName} avatarUrl={authorAvatarUrl} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* Grouped: the author line is visually hidden, and "Not sent" moves next to Retry. */}
        <div className={grouped ? 'sr-only' : 'flex min-w-0 items-baseline gap-2'}>
          <span data-testid="message-author" className="min-w-0 truncate text-sm font-semibold">
            {authorName}
          </span>
          <span className="shrink-0 text-xs whitespace-nowrap text-muted">
            {failed ? 'Not sent' : 'Sending…'}
          </span>
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
          <div className="mt-1 flex items-center gap-1">
            {grouped && (
              <span aria-hidden="true" className="mr-1 text-xs text-muted">
                Not sent
              </span>
            )}
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
