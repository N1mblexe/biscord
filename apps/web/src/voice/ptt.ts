import { upper } from '../i18n/format';
import { t } from '../i18n/translate';
import type { KeyBinding, VoicePrefs } from './prefs';

/**
 * Push-to-talk and the voice shortcut keys (CONTRACTS B.12 rule 3, docs/plans/devices.md). The PTT
 * machine is fed by named sources: `'page'` (this tab's key, mouse button or hold button) and, later,
 * `'helper'` (the desktop helper, docs/plans/ptt-helper.md §3). It is active while any source holds
 * it. No LiveKit here: VoiceProvider (initial bundle) owns it.
 */

/** The source for keys, mouse buttons and the on-screen hold button in this page. */
export const PAGE_SOURCE = 'page';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

interface ElementLike {
  tagName?: unknown;
  type?: unknown;
  isContentEditable?: unknown;
}

/** Focus is in a place that takes typing: a text input, textarea, select or contenteditable. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as ElementLike;
  if (el.isContentEditable === true) return true;
  if (typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof el.type === 'string' ? el.type.toLowerCase() : 'text';
  return !NON_TEXT_INPUT_TYPES.has(type);
}

const PRINTING_CODES = new Set([
  'Space',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  // Keys that edit text too: typing in a field must never trigger a shortcut with them.
  'Enter',
  'NumpadEnter',
  'Backspace',
  'Delete',
  'Tab',
  'NumpadDecimal',
  'NumpadComma',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadEqual',
]);

/** A key that types (or edits) text in a field: letters, digits, punctuation, Space, Backquote… */
export function isPrintingKey(code: string): boolean {
  return /^(Key[A-Z]|Digit\d|Numpad\d)$/.test(code) || PRINTING_CODES.has(code);
}

/** `e` is the bound key (by `code`) or mouse button. */
export function matchesBinding(b: KeyBinding | null, e: KeyboardEvent | MouseEvent): boolean {
  if (b === null) return false;
  if ('code' in e) return b.type === 'key' && e.code === b.code;
  return b.type === 'mouse' && e.button === b.button;
}

export interface PushToTalk {
  /** `source` (default `'page'`) holds the key; cancels that source's pending release. */
  press: (source?: string) => void;
  /**
   * `source` (default `'page'`) let go: released after the release delay (`releaseMs`), or at once
   * with `{ immediate: true }` (the desktop helper applies its own delay). A press meanwhile keeps it.
   */
  release: (source?: string, opts?: { immediate?: boolean }) => void;
  /** Every source released at once (leaving voice, switching to voice activity). */
  releaseNow: () => void;
  /** Some source holds it (a release still waiting out its delay counts as held). */
  active: () => boolean;
  /** Clears timers and held sources without calling `onChange`. */
  dispose: () => void;
}

export function createPushToTalk(opts: {
  releaseMs: () => number;
  onChange: (active: boolean) => void;
}): PushToTalk {
  const held = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let wasActive = false;

  const notify = () => {
    const now = held.size > 0;
    if (now === wasActive) return;
    wasActive = now;
    opts.onChange(now);
  };
  const cancelTimer = (source: string) => {
    const timer = timers.get(source);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(source);
  };
  const drop = (source: string) => {
    cancelTimer(source);
    held.delete(source);
    notify();
  };

  return {
    press: (source = PAGE_SOURCE) => {
      cancelTimer(source);
      held.add(source);
      notify();
    },
    release: (source = PAGE_SOURCE, releaseOpts) => {
      if (!held.has(source)) return;
      const delay = releaseOpts?.immediate === true ? 0 : Math.max(0, opts.releaseMs());
      if (delay === 0) {
        drop(source);
        return;
      }
      if (timers.has(source)) return;
      timers.set(
        source,
        setTimeout(() => {
          timers.delete(source);
          drop(source);
        }, delay),
      );
    },
    releaseNow: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      held.clear();
      notify();
    },
    active: () => held.size > 0,
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      held.clear();
      wasActive = false;
    },
  };
}

/**
 * The page's push-to-talk key/mouse button and the optional mute/deafen shortcuts, on `win`. Only
 * while `enabled()` (VoiceProvider: connected). Printing keys are ignored while typing in a field;
 * mouse side buttons and non-printing keys work everywhere in the page. Window blur and tab hide
 * release the `'page'` source at once (its key-up would never arrive); other sources are untouched.
 * Returns the unbind function (which also releases `'page'`).
 */
export function bindVoiceShortcuts(
  win: Window,
  opts: {
    prefs: () => VoicePrefs;
    enabled: () => boolean;
    ptt: PushToTalk;
    onToggleMute: () => void;
    onToggleDeafen: () => void;
  },
): () => void {
  const { ptt } = opts;
  const releasePage = () => {
    ptt.release(PAGE_SOURCE, { immediate: true });
  };

  /** Handles a press of `e` (key or mouse button); true when it was one of ours. */
  const onPress = (e: KeyboardEvent | MouseEvent, repeat: boolean): boolean => {
    if (!opts.enabled()) return false;
    const prefs = opts.prefs();
    let handled = false;
    if (prefs.inputMode === 'ptt' && matchesBinding(prefs.pttKey, e)) {
      ptt.press(PAGE_SOURCE);
      handled = true;
    }
    if (matchesBinding(prefs.muteKey, e)) {
      if (!repeat) opts.onToggleMute();
      handled = true;
    }
    if (matchesBinding(prefs.deafenKey, e)) {
      if (!repeat) opts.onToggleDeafen();
      handled = true;
    }
    return handled;
  };

  /** A release always goes through (even disabled or in a field): never leave the key stuck. */
  const onRelease = (e: KeyboardEvent | MouseEvent): boolean => {
    const prefs = opts.prefs();
    if (!matchesBinding(prefs.pttKey, e)) return false;
    ptt.release(PAGE_SOURCE);
    return opts.enabled();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (isEditableTarget(e.target) && isPrintingKey(e.code)) return;
    if (onPress(e, e.repeat)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (onRelease(e) && !isEditableTarget(e.target)) e.preventDefault();
  };
  const isSideButton = (e: MouseEvent) => e.button === 3 || e.button === 4;
  const onPointerDown = (e: PointerEvent) => {
    if (!isSideButton(e)) return;
    if (onPress(e, false)) e.preventDefault();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!isSideButton(e)) return;
    if (onRelease(e)) e.preventDefault();
  };
  /** A bound side button must not also navigate back/forward (Chromium acts on mouseup). */
  const onMouseUp = (e: MouseEvent) => {
    if (!isSideButton(e) || !opts.enabled()) return;
    const prefs = opts.prefs();
    if (
      matchesBinding(prefs.pttKey, e) ||
      matchesBinding(prefs.muteKey, e) ||
      matchesBinding(prefs.deafenKey, e)
    ) {
      e.preventDefault();
    }
  };
  const onVisibility = () => {
    if (win.document.visibilityState === 'hidden') releasePage();
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('pointerdown', onPointerDown);
  win.addEventListener('pointerup', onPointerUp);
  win.addEventListener('mouseup', onMouseUp);
  win.addEventListener('blur', releasePage);
  win.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('pointerdown', onPointerDown);
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('mouseup', onMouseUp);
    win.removeEventListener('blur', releasePage);
    win.document.removeEventListener('visibilitychange', onVisibility);
    releasePage();
  };
}

/**
 * Waits for the next key or mouse side button on `win` and returns it as a binding; Escape (or
 * `signal` aborting) gives `null`. The event is swallowed so it doesn't act on the page.
 */
export function recordBinding(win: Window, signal?: AbortSignal): Promise<KeyBinding | null> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(null);
      return;
    }
    let swallowButton: number | null = null;
    const finish = (binding: KeyBinding | null) => {
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('pointerdown', onPointerDown, true);
      signal?.removeEventListener('abort', onAbort);
      if (swallowButton === null) win.removeEventListener('mouseup', onMouseUp, true);
      resolve(binding);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.code === '') return;
      e.preventDefault();
      e.stopPropagation();
      finish(e.code === 'Escape' ? null : { type: 'key', code: e.code });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      e.stopPropagation();
      swallowButton = e.button;
      finish({ type: 'mouse', button: e.button });
    };
    // The side button's own mouseup would navigate back/forward: swallow that one, then stop.
    const onMouseUp = (e: MouseEvent) => {
      if (swallowButton === null || e.button !== swallowButton) return;
      e.preventDefault();
      win.removeEventListener('mouseup', onMouseUp, true);
    };
    const onAbort = () => {
      finish(null);
    };
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('pointerdown', onPointerDown, true);
    win.addEventListener('mouseup', onMouseUp, true);
    signal?.addEventListener('abort', onAbort);
  });
}

const CODE_SYMBOLS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  NumpadDecimal: 'Numpad .',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad -',
  NumpadMultiply: 'Numpad *',
  NumpadDivide: 'Numpad /',
  NumpadEnter: 'Numpad Enter',
};

const SIDED = /^(Shift|Control|Alt|Meta)(Left|Right)$/;

/** A key code as a person reads it, without a keyboard layout. */
function codeLabel(code: string): string {
  const symbol = CODE_SYMBOLS[code];
  if (symbol !== undefined) return symbol;
  if (code === 'Space') return t('voice.keys.space');
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1] !== undefined) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1] !== undefined) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad?.[1] !== undefined) return `Numpad ${numpad[1]}`;
  const sided = SIDED.exec(code);
  if (sided?.[1] !== undefined) {
    const key = sided[1] === 'Control' ? 'Ctrl' : sided[1];
    return sided[2] === 'Left' ? t('voice.keys.left', { key }) : t('voice.keys.right', { key });
  }
  return code;
}

/**
 * A binding's label in the UI language: `` ` ``, `A`, `F13`, `Left Shift`, `Mouse 4`, or "Not set".
 * `layout` (from `navigator.keyboard.getLayoutMap()`, where supported) gives the character a key
 * types on the user's layout. Mouse buttons are numbered from 1 (button 3 = "Mouse 4", back).
 */
export function bindingLabel(b: KeyBinding | null, layout?: ReadonlyMap<string, string>): string {
  if (b === null) return t('voice.keys.none');
  if (b.type === 'mouse') return t('voice.keys.mouse', { n: b.button + 1 });
  const typed = layout?.get(b.code);
  if (typed !== undefined && typed.trim() !== '' && b.code !== 'Space') return upper(typed);
  return codeLabel(b.code);
}
