import { useEffect, useRef, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import { useVoice } from '../../voice/context';
import { useVoicePrefs } from '../../voice/prefs';
import { bindingLabel } from '../../voice/ptt';
import { useVoiceSession } from '../../voice/session';

/**
 * Push-to-talk mode in the voice panel (docs/plans/devices.md, "Voice panel"): the **Push to talk**
 * hold button (`ptt-button`, `aria-pressed` = push-to-talk active from any source) and the hint
 * "Hold `<key>` to talk" (`ptt-hint`). The button transmits while a pointer holds it (captured, so
 * sliding off doesn't drop it) or while Space/Enter is held on it; up, cancel, lost capture and blur
 * release (after the release delay, like the key).
 */
export function PttButton() {
  const t = useT();
  const { pttPress, pttRelease } = useVoice();
  const pttActive = useVoiceSession((s) => s.pttActive);
  const pttKey = useVoicePrefs((s) => s.prefs.pttKey);
  /** This button is holding push-to-talk (so a stray up or blur doesn't release someone else's hold). */
  const held = useRef(false);

  const press = () => {
    if (held.current) return;
    held.current = true;
    pttPress();
  };
  const release = () => {
    if (!held.current) return;
    held.current = false;
    pttRelease();
  };
  const releaseRef = useRef(release);
  useEffect(() => {
    releaseRef.current = release;
  });
  // Unmounting mid-hold (leaving, switching to voice activity) must not leave the hold on.
  useEffect(
    () => () => {
      releaseRef.current();
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // no text selection or emulated mouse events on touch
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): hold without capture.
    }
    press();
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="ptt-button"
        aria-pressed={pttActive}
        style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
        className={`flex min-h-9 w-full items-center justify-center gap-1.5 rounded-control px-2 py-1.5 text-xs font-semibold ring-1 transition select-none ${
          pttActive
            ? 'bg-success/20 text-success ring-success/50'
            : 'bg-white/5 text-text ring-line hover:bg-white/10'
        }`}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onContextMenu={(e) => {
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            press();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            release();
          }
        }}
        onBlur={release}
      >
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${pttActive ? 'bg-success' : 'bg-muted/50'}`}
        />
        {t('voice.ptt.button')}
      </button>
      <p data-testid="ptt-hint" className="px-0.5 text-2xs text-muted">
        {t('voice.ptt.hint', { key: bindingLabel(pttKey) })}
      </p>
    </div>
  );
}
