import { EMOJI_PALETTE, type Message, type PublicUser } from '@hearth/shared';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../../i18n';
import { authorName } from '../../lib/bootstrapPatch';

/** Gap between the trigger and the palette, and the minimum distance from the viewport edges. */
const GAP_PX = 4;
const EDGE_PX = 8;

interface ReactionBarProps {
  message: Message;
  meId: string;
  usersById: ReadonlyMap<string, PublicUser>;
  /** Read-only DM: the buttons show the counts but can't be toggled. */
  disabled: boolean;
  onToggle: (emoji: string, add: boolean) => void;
}

/** One `reaction` toggle button per emoji under a message (`<emoji> <count>`, pressed when mine). */
export function ReactionBar({ message, meId, usersById, disabled, onToggle }: ReactionBarProps) {
  const t = useT();
  if (message.reactions.length === 0) return null;
  return (
    <ul aria-label={t('chat.reactions.label')} className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map(({ emoji, userIds }) => {
        const mine = userIds.includes(meId);
        const who = userIds.map((id) => authorName(usersById.get(id))).join(', ');
        return (
          <li key={emoji}>
            <button
              type="button"
              data-testid="reaction"
              aria-pressed={mine}
              title={who}
              disabled={disabled}
              onClick={() => {
                onToggle(emoji, !mine);
              }}
              className={`rounded-full px-2 py-0.5 text-xs tabular-nums ring-1 transition focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
                mine
                  ? 'bg-accent/15 text-text ring-accent/60 hover:bg-accent/25'
                  : 'bg-surface-raised text-muted ring-white/10 hover:bg-white/10 hover:text-text'
              }`}
            >
              {`${emoji} ${userIds.length}`}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SmileyPlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path
        d="M13.5 8A5.5 5.5 0 1 1 8 2.5M5.8 9.6a2.8 2.8 0 0 0 4.4 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M6 6.4v.1M10 6.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13 1v4M11 3h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * **Add reaction**: a button that opens the emoji palette, a modal `role="dialog"` named
 * **Add reaction**. Picking an emoji or pressing Escape (or clicking outside) closes it and returns
 * focus to the button. `tabIndex` lets the message keep it out of the tab order until it is focused.
 */
export function AddReaction({
  className,
  tabIndex,
  onPick,
}: {
  className: string;
  tabIndex?: number;
  onPick: (emoji: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('chat.reactions.add')}
        title={t('chat.reactions.add')}
        aria-haspopup="dialog"
        aria-expanded={open}
        tabIndex={tabIndex}
        className={className}
        onClick={() => {
          setOpen(true);
        }}
      >
        <SmileyPlusIcon />
      </button>
      {open && (
        <ReactionPalette
          anchorRef={triggerRef}
          onPick={onPick}
          onClosed={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** Places the open palette under the anchor (above it if there's no room), inside the viewport. */
function place(dialog: HTMLDialogElement, anchor: HTMLElement | null): void {
  const box = dialog.getBoundingClientRect();
  const maxLeft = window.innerWidth - box.width - EDGE_PX;
  const maxTop = window.innerHeight - box.height - EDGE_PX;
  let top = (window.innerHeight - box.height) / 2;
  let left = (window.innerWidth - box.width) / 2;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    top = a.bottom + GAP_PX > maxTop ? a.top - box.height - GAP_PX : a.bottom + GAP_PX;
    left = a.right - box.width;
  }
  dialog.style.top = `${Math.max(EDGE_PX, Math.min(top, maxTop))}px`;
  dialog.style.left = `${Math.max(EDGE_PX, Math.min(left, maxLeft))}px`;
}

function ReactionPalette({
  anchorRef,
  onPick,
  onClosed,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onPick: (emoji: string) => void;
  /** The dialog closed (picked, Escape, click outside). */
  onClosed: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // A native modal <dialog>: top layer (never clipped by the scrolling history), inert background,
  // focus moves into it, Escape closes it.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    place(dialog, anchorRef.current);
    return () => {
      dialog.close();
    };
  }, [anchorRef]);

  const close = () => {
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-label={t('chat.reactions.add')}
      // pointer-events-auto: the message toolbar that holds the trigger turns pointer events off
      // while hidden, and pointer-events is inherited.
      className="pointer-events-auto fixed inset-auto m-0 rounded-lg bg-surface-raised p-0 text-text shadow-xl ring-1 ring-white/10 backdrop:bg-transparent"
      onClose={() => {
        // StrictMode re-runs the effect (close, then showModal again); the first `close` event then
        // arrives while the dialog is open again and must be ignored.
        if (!dialogRef.current?.open) onClosed();
      }}
      onClick={(event) => {
        // A click on the dialog element itself (not its content) is a click on the backdrop.
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="grid grid-cols-8 gap-0.5 p-2">
        {EMOJI_PALETTE.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            className="flex size-8 items-center justify-center rounded-md text-lg transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => {
              onPick(emoji);
              close();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </dialog>
  );
}
