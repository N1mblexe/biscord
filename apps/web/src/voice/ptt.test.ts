import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocaleStore } from '../i18n/store';
import { DEFAULT_VOICE_PREFS, type KeyBinding, type VoicePrefs } from './prefs';
import {
  bindingLabel,
  bindVoiceShortcuts,
  createPushToTalk,
  isEditableTarget,
  isPrintingKey,
  matchesBinding,
  recordBinding,
  type PushToTalk,
} from './ptt';

type Listener = (e: never) => void;

/** A minimal Window + Document event target (Vitest runs in node). */
function fakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  const docListeners = new Map<string, Set<Listener>>();
  const add = (map: Map<string, Set<Listener>>) => (type: string, fn: Listener) => {
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(fn);
  };
  const remove = (map: Map<string, Set<Listener>>) => (type: string, fn: Listener) => {
    map.get(type)?.delete(fn);
  };
  const document = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: add(docListeners),
    removeEventListener: remove(docListeners),
  };
  const win = { addEventListener: add(listeners), removeEventListener: remove(listeners), document };
  const fire = (map: Map<string, Set<Listener>>, type: string, event: object) => {
    for (const fn of [...(map.get(type) ?? [])]) (fn as (e: object) => void)(event);
  };
  return {
    win: win as unknown as Window,
    document,
    count: () => [...listeners.values(), ...docListeners.values()].reduce((n, s) => n + s.size, 0),
    /** Dispatches a key event; returns its preventDefault spy. */
    key: (type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}) => {
      const preventDefault = vi.fn();
      fire(listeners, type, {
        code,
        repeat: false,
        isComposing: false,
        target: { tagName: 'BODY' },
        preventDefault,
        stopPropagation: () => undefined,
        ...extra,
      });
      return preventDefault;
    },
    pointer: (type: 'pointerdown' | 'pointerup' | 'mouseup', button: number) => {
      const preventDefault = vi.fn();
      fire(listeners, type, {
        button,
        target: { tagName: 'BODY' },
        preventDefault,
        stopPropagation: () => undefined,
      });
      return preventDefault;
    },
    blur: () => {
      fire(listeners, 'blur', {});
    },
    hide: () => {
      document.visibilityState = 'hidden';
      fire(docListeners, 'visibilitychange', {});
    },
  };
}

const textInput = { tagName: 'INPUT', type: 'text' };

describe('isEditableTarget', () => {
  it.each([
    [{ tagName: 'INPUT', type: 'text' }, true],
    [{ tagName: 'INPUT', type: 'search' }, true],
    [{ tagName: 'input' }, true],
    [{ tagName: 'TEXTAREA' }, true],
    [{ tagName: 'SELECT' }, true],
    [{ tagName: 'DIV', isContentEditable: true }, true],
    [{ tagName: 'INPUT', type: 'checkbox' }, false],
    [{ tagName: 'INPUT', type: 'range' }, false],
    [{ tagName: 'BUTTON' }, false],
    [{ tagName: 'DIV', isContentEditable: false }, false],
    [null, false],
  ])('%j → %s', (target, expected) => {
    expect(isEditableTarget(target as EventTarget | null)).toBe(expected);
  });
});

describe('isPrintingKey', () => {
  it.each([
    'KeyA',
    'KeyZ',
    'Digit0',
    'Space',
    'Backquote',
    'Minus',
    'Slash',
    'Quote',
    'Numpad5',
    'Enter',
    'Backspace',
  ])('%s prints', (code) => {
    expect(isPrintingKey(code)).toBe(true);
  });
  it.each([
    'F13',
    'F1',
    'ShiftLeft',
    'ControlRight',
    'AltLeft',
    'CapsLock',
    'ArrowUp',
    'Escape',
    'Insert',
    'Pause',
  ])('%s does not', (code) => {
    expect(isPrintingKey(code)).toBe(false);
  });
});

describe('matchesBinding', () => {
  const key = { code: 'Backquote' } as KeyboardEvent;
  const mouse4 = { button: 3 } as MouseEvent;
  it('keys by code, mouse by button, null never', () => {
    expect(matchesBinding({ type: 'key', code: 'Backquote' }, key)).toBe(true);
    expect(matchesBinding({ type: 'key', code: 'KeyA' }, key)).toBe(false);
    expect(matchesBinding({ type: 'mouse', button: 3 }, mouse4)).toBe(true);
    expect(matchesBinding({ type: 'mouse', button: 4 }, mouse4)).toBe(false);
    expect(matchesBinding({ type: 'mouse', button: 3 }, key)).toBe(false);
    expect(matchesBinding({ type: 'key', code: 'Backquote' }, mouse4)).toBe(false);
    expect(matchesBinding(null, key)).toBe(false);
  });
});

describe('createPushToTalk', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function machine(releaseMs = 200) {
    const changes: boolean[] = [];
    const ptt = createPushToTalk({
      releaseMs: () => releaseMs,
      onChange: (active) => {
        changes.push(active);
      },
    });
    return { ptt, changes };
  }

  it('press → active; release waits out the delay', () => {
    const { ptt, changes } = machine(200);
    ptt.press();
    expect(ptt.active()).toBe(true);
    ptt.release();
    vi.advanceTimersByTime(199);
    expect(ptt.active()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(ptt.active()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('key repeat (press, press, press) is one activation; a press during the delay keeps it', () => {
    const { ptt, changes } = machine(200);
    ptt.press();
    ptt.press();
    ptt.press();
    ptt.release();
    vi.advanceTimersByTime(150);
    ptt.press();
    vi.advanceTimersByTime(500);
    expect(ptt.active()).toBe(true);
    ptt.release();
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([true, false]);
  });

  it('a 0 ms delay releases at once; a release without a press does nothing', () => {
    const { ptt, changes } = machine(0);
    ptt.release();
    ptt.press();
    ptt.release();
    expect(ptt.active()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('named sources: active while any source holds it', () => {
    const { ptt, changes } = machine(200);
    ptt.press('page');
    ptt.press('helper');
    ptt.release('page');
    vi.advanceTimersByTime(1000);
    expect(ptt.active()).toBe(true);
    ptt.release('helper', { immediate: true });
    expect(ptt.active()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('an immediate release has no delay', () => {
    const { ptt } = machine(500);
    ptt.press('helper');
    ptt.release('helper', { immediate: true });
    expect(ptt.active()).toBe(false);
  });

  it('releaseNow clears every source and pending delay; dispose is silent', () => {
    const { ptt, changes } = machine(200);
    ptt.press('page');
    ptt.press('helper');
    ptt.release('page');
    ptt.releaseNow();
    expect(ptt.active()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true, false]);
    ptt.press();
    ptt.dispose();
    expect(ptt.active()).toBe(false);
    expect(changes).toEqual([true, false, true]);
  });
});

describe('bindVoiceShortcuts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(patch: Partial<VoicePrefs> = {}) {
    const w = fakeWindow();
    let prefs: VoicePrefs = { ...DEFAULT_VOICE_PREFS, inputMode: 'ptt', ...patch };
    let enabled = true;
    const ptt: PushToTalk = createPushToTalk({
      releaseMs: () => prefs.pttReleaseMs,
      onChange: () => undefined,
    });
    const onToggleMute = vi.fn();
    const onToggleDeafen = vi.fn();
    const unbind = bindVoiceShortcuts(w.win, {
      prefs: () => prefs,
      enabled: () => enabled,
      ptt,
      onToggleMute,
      onToggleDeafen,
    });
    return {
      ...w,
      ptt,
      onToggleMute,
      onToggleDeafen,
      unbind,
      setPrefs: (p: Partial<VoicePrefs>) => {
        prefs = { ...prefs, ...p };
      },
      setEnabled: (v: boolean) => {
        enabled = v;
      },
    };
  }

  it('the PTT key holds it (preventing the default), key-up releases after the delay', () => {
    const s = setup({ pttReleaseMs: 200 });
    expect(s.key('keydown', 'Backquote')).toHaveBeenCalled();
    s.key('keydown', 'Backquote', { repeat: true });
    expect(s.ptt.active()).toBe(true);
    s.key('keyup', 'Backquote');
    vi.advanceTimersByTime(199);
    expect(s.ptt.active()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.ptt.active()).toBe(false);
  });

  it('ignored in voice-activity mode and while not enabled (not connected)', () => {
    const s = setup({ inputMode: 'voice' });
    expect(s.key('keydown', 'Backquote')).not.toHaveBeenCalled();
    expect(s.ptt.active()).toBe(false);
    s.setPrefs({ inputMode: 'ptt' });
    s.setEnabled(false);
    s.key('keydown', 'Backquote');
    expect(s.ptt.active()).toBe(false);
  });

  it('a printing PTT key is ignored while typing in a field; a non-printing one works there', () => {
    const s = setup({ pttReleaseMs: 0 });
    expect(s.key('keydown', 'Backquote', { target: textInput })).not.toHaveBeenCalled();
    expect(s.ptt.active()).toBe(false);

    s.setPrefs({ pttKey: { type: 'key', code: 'F13' } });
    s.key('keydown', 'F13', { target: textInput });
    expect(s.ptt.active()).toBe(true);
    s.key('keyup', 'F13', { target: textInput });
    expect(s.ptt.active()).toBe(false);
  });

  it('key-up in a field still releases a key pressed outside it', () => {
    const s = setup({ pttReleaseMs: 0 });
    s.key('keydown', 'Backquote');
    s.key('keyup', 'Backquote', { target: textInput });
    expect(s.ptt.active()).toBe(false);
  });

  it('mouse buttons 3 and 4 (back/forward) as the PTT key, also swallowing their navigation', () => {
    const s = setup({ pttKey: { type: 'mouse', button: 4 }, pttReleaseMs: 0 });
    s.pointer('pointerdown', 3);
    expect(s.ptt.active()).toBe(false);
    expect(s.pointer('pointerdown', 4)).toHaveBeenCalled();
    expect(s.ptt.active()).toBe(true);
    expect(s.pointer('mouseup', 4)).toHaveBeenCalled();
    s.pointer('pointerup', 4);
    expect(s.ptt.active()).toBe(false);
    // An unbound side button navigates as usual; the main button is never touched.
    expect(s.pointer('mouseup', 3)).not.toHaveBeenCalled();
    expect(s.pointer('pointerdown', 0)).not.toHaveBeenCalled();
  });

  it('mute and deafen shortcuts toggle once per press (not on repeat), in any input mode', () => {
    const s = setup({
      inputMode: 'voice',
      muteKey: { type: 'key', code: 'F14' },
      deafenKey: { type: 'mouse', button: 3 },
    });
    s.key('keydown', 'F14');
    s.key('keydown', 'F14', { repeat: true });
    s.key('keyup', 'F14');
    s.pointer('pointerdown', 3);
    expect(s.onToggleMute).toHaveBeenCalledTimes(1);
    expect(s.onToggleDeafen).toHaveBeenCalledTimes(1);
  });

  it('a printing shortcut key is ignored while typing', () => {
    const s = setup({ muteKey: { type: 'key', code: 'KeyM' } });
    s.key('keydown', 'KeyM', { target: { tagName: 'TEXTAREA' } });
    expect(s.onToggleMute).not.toHaveBeenCalled();
    s.key('keydown', 'KeyM');
    expect(s.onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('window blur and a hidden tab release the page source at once', () => {
    const s = setup({ pttReleaseMs: 1000 });
    s.key('keydown', 'Backquote');
    s.blur();
    expect(s.ptt.active()).toBe(false);
    s.key('keydown', 'Backquote');
    s.hide();
    expect(s.ptt.active()).toBe(false);
  });

  it('blur and hide leave other sources (the desktop helper) alone', () => {
    const s = setup();
    s.ptt.press('helper');
    s.key('keydown', 'Backquote');
    s.blur();
    s.hide();
    expect(s.ptt.active()).toBe(true);
    s.ptt.release('helper', { immediate: true });
    expect(s.ptt.active()).toBe(false);
  });

  it('unbinding removes every listener and releases the page source', () => {
    const s = setup();
    s.key('keydown', 'Backquote');
    expect(s.count()).toBeGreaterThan(0);
    s.unbind();
    expect(s.count()).toBe(0);
    expect(s.ptt.active()).toBe(false);
  });
});

describe('recordBinding', () => {
  it('records the next key (swallowing it) or a side button; Escape cancels', async () => {
    const w = fakeWindow();
    const keyP = recordBinding(w.win);
    const prevented = w.key('keydown', 'F13');
    await expect(keyP).resolves.toEqual({ type: 'key', code: 'F13' });
    expect(prevented).toHaveBeenCalled();

    const mouseP = recordBinding(w.win);
    w.pointer('pointerdown', 0); // a normal click is not a binding
    w.pointer('pointerdown', 4);
    await expect(mouseP).resolves.toEqual({ type: 'mouse', button: 4 });
    expect(w.pointer('mouseup', 4)).toHaveBeenCalled(); // its navigation is swallowed too

    const escP = recordBinding(w.win);
    w.key('keydown', 'Escape');
    await expect(escP).resolves.toBeNull();
    expect(w.count()).toBe(0);
  });

  it('an abort resolves null and cleans up', async () => {
    const w = fakeWindow();
    const ac = new AbortController();
    const p = recordBinding(w.win, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeNull();
    expect(w.count()).toBe(0);
    await expect(recordBinding(w.win, ac.signal)).resolves.toBeNull();
  });
});

describe('bindingLabel', () => {
  afterEach(() => {
    useLocaleStore.setState({ locale: 'en' });
  });

  const key = (code: string): KeyBinding => ({ type: 'key', code });

  it.each([
    ['Backquote', '`'],
    ['KeyA', 'A'],
    ['Digit7', '7'],
    ['Numpad3', 'Numpad 3'],
    ['F13', 'F13'],
    ['Space', 'Space'],
    ['ShiftLeft', 'Left Shift'],
    ['ControlRight', 'Right Ctrl'],
    ['CapsLock', 'CapsLock'],
  ])('%s → %s', (code, label) => {
    expect(bindingLabel(key(code))).toBe(label);
  });

  it('mouse buttons are numbered from 1; null is "Not set"', () => {
    expect(bindingLabel({ type: 'mouse', button: 3 })).toBe('Mouse 4');
    expect(bindingLabel({ type: 'mouse', button: 4 })).toBe('Mouse 5');
    expect(bindingLabel(null)).toBe('Not set');
  });

  it('uses the keyboard layout when given (upper-cased in the UI language)', () => {
    const layout = new Map([
      ['KeyQ', 'a'],
      ['KeyI', 'i'],
      ['Backquote', 'é'],
    ]);
    expect(bindingLabel(key('KeyQ'), layout)).toBe('A');
    expect(bindingLabel(key('Backquote'), layout)).toBe('É');
    expect(bindingLabel(key('KeyI'), layout)).toBe('I');
    useLocaleStore.setState({ locale: 'tr' });
    expect(bindingLabel(key('KeyI'), layout)).toBe('İ');
  });

  it('is translated', () => {
    useLocaleStore.setState({ locale: 'tr' });
    expect(bindingLabel(null)).toBe('Ayarlanmadı');
    expect(bindingLabel({ type: 'mouse', button: 3 })).toBe('Fare 4');
    expect(bindingLabel(key('ShiftRight'))).toBe('Sağ Shift');
    expect(bindingLabel(key('Space'))).toBe('Boşluk');
  });
});
