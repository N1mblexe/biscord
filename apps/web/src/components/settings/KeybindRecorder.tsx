import { useEffect, useState } from 'react';
import { useT } from '../../i18n/useT';
import { secondaryButton } from '../styles';

/** `navigator.keyboard` (Chromium only; not in the DOM typings). */
type NavigatorWithKeyboard = Navigator & {
  keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> };
};

/**
 * The user's keyboard layout (`KeyboardEvent.code` → the character it types), where the browser
 * offers it, so a key reads as the user sees it ("Ö" rather than "Semicolon"); `undefined` elsewhere.
 */
export function useKeyboardLayout(): ReadonlyMap<string, string> | undefined {
  const [layout, setLayout] = useState<ReadonlyMap<string, string>>();
  useEffect(() => {
    const keyboard = (navigator as NavigatorWithKeyboard).keyboard;
    if (keyboard?.getLayoutMap === undefined) return;
    let alive = true;
    // Rejects in cross-origin frames and some privacy modes: then plain key names are used.
    keyboard.getLayoutMap().then(
      (map) => {
        if (alive) setLayout(map);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return layout;
}

/**
 * A key binding button: shows "<label>: <key>"; a click records the next key or mouse side button
 * ("Press a key… (Esc to cancel)"). Clicking again or moving focus away cancels. The recording
 * itself (voice/ptt.ts `recordBinding`) and the polite announcement live in the section, which
 * records one binding at a time. With `clear`, a **Clear** button unsets the binding.
 */
export function KeybindRecorder({
  testId,
  label,
  recording,
  onStart,
  onCancel,
  clear,
  describedBy,
}: {
  testId: string;
  /** The idle text, e.g. "Push-to-talk key: `". */
  label: string;
  recording: boolean;
  onStart: () => void;
  onCancel: () => void;
  clear?: { label: string; disabled: boolean; onClear: () => void };
  /** The id of a hint about this binding. */
  describedBy?: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid={testId}
        data-recording={recording}
        aria-describedby={describedBy}
        className={`${secondaryButton} min-w-0 text-left break-words ${recording ? 'ring-2 ring-accent' : ''}`}
        onClick={() => {
          if (recording) onCancel();
          else onStart();
        }}
        onBlur={() => {
          if (recording) onCancel();
        }}
      >
        {recording ? t('settings.voice.recording') : label}
      </button>
      {clear && (
        <button
          type="button"
          data-testid={`${testId}-clear`}
          aria-label={clear.label}
          className={secondaryButton}
          disabled={clear.disabled}
          onClick={clear.onClear}
        >
          {t('settings.voice.clear')}
        </button>
      )}
    </div>
  );
}
