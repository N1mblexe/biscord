import { useEffect, useRef } from 'react';
import { FOCUSABLE_SELECTOR, focusReturnTarget, trapTabTarget } from '../lib/focusTrap';
import { useDrawerStore, type DrawerId } from '../stores/drawers';

/** Tailwind's `md` breakpoint: from here up the drawers are ordinary columns. */
export const DESKTOP_QUERY = '(min-width: 48rem)';

/**
 * Classes for a column that is an off-canvas drawer below `md` (fixed, sliding in from `side`) and an
 * ordinary column from `md` up. Closed, it is `invisible` on phones: out of the tab order and the
 * accessibility tree. Visibility is transitioned with the transform so it hides after sliding out.
 */
export function drawerClasses(side: 'left' | 'right', open: boolean): string {
  const base =
    'max-md:fixed max-md:inset-y-0 max-md:z-40 max-md:w-72 max-md:max-w-[85vw] max-md:shadow-2xl ' +
    'max-md:transition-[transform,visibility] max-md:duration-200 max-md:ease-out motion-reduce:transition-none';
  const edge = side === 'left' ? 'max-md:left-0' : 'max-md:right-0';
  const closed =
    side === 'left'
      ? 'max-md:invisible max-md:-translate-x-full'
      : 'max-md:invisible max-md:translate-x-full';
  return `${base} ${edge} ${open ? '' : closed}`;
}

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * A drawer panel's behaviour while it is open (phones only; see stores/drawers.ts): focus moves into
 * it, Tab and Shift+Tab stay inside it, Escape closes it, and it closes when the viewport grows to
 * `md`. On close, focus goes back to where it was before opening (the header button), unless the user
 * has already put it somewhere else. Returns the panel ref, whether it is open, and the dialog
 * attributes to spread on the panel while open (`ariaLabel` names it, unless the panel is already
 * labelled by a heading).
 */
export function useDrawerPanel<T extends HTMLElement>(id: DrawerId, ariaLabel?: string) {
  const open = useDrawerStore((s) => s.open === id);
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    if (!panel) return;
    const close = useDrawerStore.getState().close;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);

    (focusables()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // Something inside (a menu, an inline editor) already handled the key.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const active = document.activeElement;
      const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const target = trapTabTarget(items.length, current, event.shiftKey);
      if (target === null) return;
      event.preventDefault();
      (items[target] ?? panel).focus();
    };
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onViewport = () => {
      if (desktop.matches) close();
    };

    document.addEventListener('keydown', onKeyDown);
    desktop.addEventListener('change', onViewport);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      desktop.removeEventListener('change', onViewport);
      const active = document.activeElement;
      const focusLost = active === null || active === document.body || panel.contains(active);
      const back = focusReturnTarget(opener, isVisible);
      if (focusLost && back) back.focus();
    };
  }, [open]);

  // `tabIndex` lets the panel itself take focus when it has nothing focusable.
  const dialogProps = open
    ? { role: 'dialog', 'aria-modal': true, 'aria-label': ariaLabel, tabIndex: -1 }
    : {};
  return { ref, open, dialogProps };
}

/** The dimmed page behind an open drawer (phones only); a tap closes the drawer. */
export function DrawerBackdrop() {
  const open = useDrawerStore((s) => s.open !== null);
  const close = useDrawerStore((s) => s.close);
  if (!open) return null;
  return <div aria-hidden="true" className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={close} />;
}

/** The ✕ icon of a drawer's close button. */
export function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Classes for a drawer's icon-only header buttons (open / close). */
export const drawerIconButton =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-white/5 ' +
  'hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
