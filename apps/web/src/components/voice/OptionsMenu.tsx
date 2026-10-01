import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { useT } from '../../i18n';
import { menuKey, type RadioChoice } from './menuModel';

/**
 * The voice panel's quick-menu building blocks (docs/plans/devices.md, "Voice panel"): an icon-only
 * ▾ button (`aria-haspopup="menu"`, `aria-expanded`) and an ARIA menu that opens upwards over the
 * sidebar, spanning the panel's width (so it stays inside the 240 px sidebar and the 288 px drawer).
 *
 * - Opening moves focus to the checked choice (else the first item); arrows, Home and End move
 *   between items, Enter and Space activate, Escape and Tab close and focus the button again.
 * - A click outside the button and the menu closes it.
 * - Choosing a radio keeps the menu open (pick input and output in one go); the settings link closes it.
 *
 * The panel `<section>` is the positioned ancestor the menu is placed against.
 */

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]';

/** Space kept between the menu's top and the viewport edge. */
const VIEWPORT_MARGIN = 8;
/** Tallest the menu gets before it scrolls (28rem). */
const MAX_MENU_HEIGHT = 448;

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : [];
}

/** The checked radio, else the first item. */
function focusDefaultItem(menu: HTMLElement | null): void {
  const checked = menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
  (checked ?? menuItems(menu)[0])?.focus();
}

interface MenuApi {
  /** Closes the menu; `restoreFocus` puts focus back on its button. */
  close: (restoreFocus: boolean) => void;
  /** Focus fell out of the menu (the focused item went away): put it on the default item again. */
  recoverFocus: () => void;
}

const MenuContext = createContext<MenuApi | null>(null);

function useMenu(): MenuApi {
  const api = useContext(MenuContext);
  if (!api) throw new Error('menu items must be inside <OptionsMenu>');
  return api;
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 10 4-4 4 4" />
    </svg>
  );
}

export function OptionsMenu({
  testId,
  label,
  open,
  onOpenChange,
  triggerClassName,
  children,
}: {
  /** The button's testid (`audio-options` / `video-options`); the menu gets `<testId>-menu`. */
  testId: string;
  /** The button's accessible name and the menu's label. */
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName: string;
  /** The menu content; rendered (and its hooks run) only while open. */
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const menuId = useId();
  const triggerId = useId();

  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });

  const close = useCallback((restoreFocus: boolean) => {
    onOpenChangeRef.current(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const recoverFocus = useCallback(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body) focusDefaultItem(menu);
  }, []);

  const api = useMemo<MenuApi>(() => ({ close, recoverFocus }), [close, recoverFocus]);

  // Fit between the viewport top and the panel (the menu opens upwards), re-measured on resize.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || menu === null) return;
    const fit = () => {
      const host = menu.offsetParent ?? document.documentElement;
      const room = host.getBoundingClientRect().top - VIEWPORT_MARGIN;
      menu.style.maxHeight = `${String(Math.max(96, Math.min(MAX_MENU_HEIGHT, Math.floor(room))))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
    };
  }, [open]);

  useEffect(() => {
    if (open) focusDefaultItem(menuRef.current);
  }, [open]);

  // Close on a click outside the button and the menu (pressed and released outside, like the
  // participant volume menu, so a drag that ends outside doesn't count).
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (triggerRef.current?.contains(target) === true || menuRef.current?.contains(target) === true);
    let pressedInside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedInside = inside(e.target);
    };
    const onClick = (e: MouseEvent) => {
      if (pressedInside || inside(e.target)) return;
      // Give focus back to the button unless the click put it somewhere else on purpose.
      const active = document.activeElement;
      const lost = active === null || active === document.body || menuRef.current?.contains(active) === true;
      close(lost);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('click', onClick);
    };
  }, [open, close]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menuRef.current);
    const index = items.findIndex((item) => item === document.activeElement);
    const result = menuKey(e.key, index, items.length);
    if (result === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (result.type === 'close') close(true);
    else if (result.type === 'focus') items[result.index]?.focus();
    else items[index]?.click();
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        data-testid={testId}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={triggerClassName}
        onClick={() => {
          onOpenChange(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (open) focusDefaultItem(menuRef.current);
            else onOpenChange(true);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            close(true);
          }
        }}
      >
        <ChevronIcon />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          tabIndex={-1}
          data-testid={`${testId}-menu`}
          className="absolute inset-x-2 bottom-full z-20 mb-1 flex flex-col overflow-y-auto overscroll-contain rounded-control bg-surface-raised p-1 shadow-card ring-1 ring-white/10 outline-none"
          onKeyDown={onMenuKeyDown}
        >
          <MenuContext value={api}>{children}</MenuContext>
        </div>
      )}
    </>
  );
}

const itemClass =
  'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text ' +
  'select-none hover:bg-white/10 focus:bg-white/10 focus-visible:outline-offset-[-2px]';

function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-full ring-1 ${
        checked ? 'ring-accent' : 'ring-muted/60'
      }`}
    >
      {checked && <span className="size-1.5 rounded-full bg-accent" />}
    </span>
  );
}

/** A labelled group of `menuitemradio`s (`data-value` on each); choosing one calls `onChoose`. */
export function MenuRadioGroup({
  testId,
  label,
  choices,
  checked,
  onChoose,
}: {
  testId: string;
  label: string;
  choices: readonly RadioChoice[];
  checked: string;
  onChoose: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} data-testid={testId} className="flex flex-col">
      <div id={labelId} className="px-2 pt-1.5 pb-0.5 text-2xs font-semibold text-muted">
        {label}
      </div>
      {choices.map((choice) => (
        <div
          key={choice.value}
          role="menuitemradio"
          aria-checked={choice.value === checked}
          tabIndex={-1}
          data-value={choice.value}
          className={itemClass}
          onClick={() => {
            onChoose(choice.value);
          }}
        >
          <RadioMark checked={choice.value === checked} />
          <span className="min-w-0 break-words">{choice.label}</span>
        </div>
      ))}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px shrink-0 bg-line" />;
}

/** **Allow access**: asks for the device permission so the menu can show device names. */
export function MenuAccessItem({ onRequest }: { onRequest: () => Promise<boolean> }) {
  const t = useT();
  const { recoverFocus } = useMenu();
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      data-testid="menu-device-access"
      className={`${itemClass} font-semibold text-accent`}
      onClick={() => {
        void onRequest().then(recoverFocus);
      }}
    >
      {t('voice.options.allowAccess')}
    </div>
  );
}

/**
 * Re-focuses the menu when the focused item disappears, e.g. **Allow access** once names are
 * shown; call with a value that changes when the items do.
 */
export function useRecoverMenuFocus(dependency: unknown): void {
  const { recoverFocus } = useMenu();
  useEffect(() => {
    recoverFocus();
  }, [dependency, recoverFocus]);
}

/** **Voice & video settings** → `/settings#voice`; closes the menu. */
export function MenuSettingsLink() {
  const t = useT();
  const { close } = useMenu();
  return (
    <Link
      to="/settings#voice"
      role="menuitem"
      tabIndex={-1}
      data-testid="menu-voice-settings"
      className={`${itemClass} text-muted hover:text-text focus:text-text`}
      onClick={() => {
        close(false);
      }}
    >
      {t('voice.options.settings')}
    </Link>
  );
}
