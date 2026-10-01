import type { Locale } from '@hearth/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocaleStore } from '../../i18n/store';
import { tFor } from '../../i18n/translate';
import type { TFunction } from '../../i18n/types';
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from '../../voice/prefs';
import { VoiceVideoSection, type VoiceAlertPart } from './VoiceVideoSection';

/**
 * A server render reads zustand stores through their initial state (useSyncExternalStore's server
 * snapshot), so the prefs hook and `useT` are replaced by ones that read the test's values.
 */
const current = vi.hoisted((): { prefs: VoicePrefs | null; locale: Locale } => ({
  prefs: null,
  locale: 'en',
}));

vi.mock('../../voice/prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../voice/prefs')>();
  const state = () => ({
    prefs: current.prefs ?? actual.DEFAULT_VOICE_PREFS,
    update: () => undefined,
    reset: () => undefined,
    reload: () => undefined,
  });
  const useVoicePrefs = <T>(selector: (s: ReturnType<typeof state>) => T): T => selector(state());
  useVoicePrefs.getState = state;
  return { ...actual, useVoicePrefs };
});

vi.mock('../../i18n/useT', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/useT')>();
  const useT = (): TFunction => (key, params) => tFor(current.locale, key, params);
  return { ...actual, useT };
});

function render(
  prefs: Partial<VoicePrefs> = {},
  alert: { part: VoiceAlertPart; message: string } | null = null,
): string {
  current.prefs = { ...DEFAULT_VOICE_PREFS, ...prefs };
  return renderToStaticMarkup(
    createElement(VoiceVideoSection, {
      alert: alert?.message ?? null,
      alertPart: alert?.part ?? null,
      onStart: () => undefined,
      onError: () => undefined,
    }),
  );
}

/** Both the hook and plain `t()` (key names in voice/ptt.ts) in `locale`. */
function setLocale(locale: Locale) {
  current.locale = locale;
  useLocaleStore.getState().setLocale(locale);
}

function testIds(html: string): string[] {
  return Array.from(html.matchAll(/data-testid="([^"]+)"/g), (m) => m[1] ?? '');
}

/** The text of the element carrying `data-testid="<id>"` (no nested elements expected). */
function testIdText(html: string, id: string): string | undefined {
  return new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];
}

describe('VoiceVideoSection', () => {
  beforeEach(() => {
    // Output selection needs HTMLMediaElement.setSinkId (absent in node).
    vi.stubGlobal('HTMLMediaElement', { prototype: { setSinkId: () => Promise.resolve() } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    current.prefs = null;
    setLocale('en');
  });

  it('renders the contract controls in the devices.md order', () => {
    const html = render();
    expect(html).toContain('id="voice"');
    expect(html).toContain('aria-labelledby="settings-voice-heading"');
    expect(testIdText(html, 'settings-voice-heading')).toBe('Voice &amp; video');
    const ids = testIds(html).filter((id) => !id.startsWith('input-mode-') && !id.endsWith('-clear'));
    expect(ids).toEqual([
      'settings-voice-heading',
      'mic-select',
      'speaker-select',
      'camera-select',
      'mic-meter-toggle',
      'mic-level',
      'mic-test',
      'speaker-test',
      'input-mode',
      'vad-gate',
      'mute-key',
      'deafen-key',
      'keybind-status',
      'ns-toggle',
      'ec-toggle',
      'agc-toggle',
      'camera-preview-toggle',
      'camera-preview',
      'camera-quality-select',
    ]);
  });

  it('uses the contract names in English', () => {
    const html = render();
    for (const text of [
      'Input device',
      'Output device',
      'Camera',
      'Input level',
      'Use headphones to avoid echo.',
      'Input mode',
      'Voice activity',
      'Push to talk',
      'Only transmit above the sensitivity',
      'Noise suppression',
      'Echo cancellation',
      'Automatic gain control',
      'Video quality',
    ]) {
      expect(html).toContain(`>${text}<`);
    }
    expect(testIdText(html, 'mic-meter-toggle')).toBe('Test microphone');
    expect(testIdText(html, 'mic-test')).toBe('Let&#x27;s check');
    expect(html).toMatch(/data-testid="mic-test"[^>]*aria-pressed="false"/);
    expect(testIdText(html, 'speaker-test')).toBe('Play test sound');
    expect(testIdText(html, 'mute-key')).toBe('Toggle mute shortcut: Not set');
    expect(testIdText(html, 'deafen-key')).toBe('Toggle deafen shortcut: Not set');
    expect(testIdText(html, 'camera-preview-toggle')).toBe('Preview camera');
    expect(html).toMatch(/<option value="default"[^>]*>Default<\/option>/);
    expect(html).toContain('<option value="360p">360p</option>');
  });

  it('labels every control and groups the input mode radios', () => {
    const html = render();
    for (const id of [
      'settings-mic',
      'settings-speaker',
      'settings-camera',
      'settings-mic-level',
      'settings-input-mode-voice',
      'settings-input-mode-ptt',
      'settings-vad-gate',
      'settings-noise-suppression',
      'settings-echo-cancellation',
      'settings-auto-gain',
      'settings-camera-quality',
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/<fieldset[^>]*role="radiogroup"[^>]*aria-labelledby="settings-input-mode-legend"/);
    expect(html).toContain('<legend id="settings-input-mode-legend"');
    expect(html).toMatch(/<meter[^>]*data-testid="mic-level"[^>]*data-level="-100"/);
    expect(html).toMatch(/<video[^>]*data-testid="camera-preview"[^>]*playsInline=""/);
    expect(html).toMatch(/<video[^>]*muted=""/);
  });

  it('shows the sensitivity and the meter marker only while gating', () => {
    expect(testIds(render())).not.toContain('vad-threshold');
    const html = render({ vadGate: true, vadThresholdDb: -40 });
    expect(testIds(html)).toContain('vad-threshold');
    expect(testIds(html)).toContain('mic-threshold');
    expect(html).toContain('left:60%');
    expect(html).toContain('-40 dB');
  });

  it('push to talk: the key, the release delay and the focus hint', () => {
    const html = render({ inputMode: 'ptt', pttReleaseMs: 250 });
    expect(testIds(html)).not.toContain('vad-gate');
    expect(testIdText(html, 'ptt-key')).toBe('Push-to-talk key: `');
    expect(html).toMatch(/data-testid="ptt-key"[^>]*aria-describedby="settings-ptt-hint"/);
    expect(testIds(html)).toContain('ptt-release');
    expect(html).toContain('250 ms');
    expect(html).toContain('Push to talk works only while Hearth is focused.');
    expect(html).toMatch(/id="settings-input-mode-ptt"[^>]*checked=""/);
  });

  it('shows bound shortcuts with an enabled Clear', () => {
    const html = render({ muteKey: { type: 'key', code: 'KeyM' }, deafenKey: { type: 'mouse', button: 4 } });
    expect(testIdText(html, 'mute-key')).toBe('Toggle mute shortcut: M');
    expect(testIdText(html, 'deafen-key')).toBe('Toggle deafen shortcut: Mouse 5');
    expect(html).toMatch(/data-testid="mute-key-clear" aria-label="Clear toggle mute shortcut"[^>]*>Clear</);
    expect(html).not.toMatch(/data-testid="mute-key-clear"[^>]*\sdisabled=""/);
    expect(render()).toMatch(/data-testid="mute-key-clear"[^>]*\sdisabled=""/);
  });

  it('hides the output select where the browser chooses the output', () => {
    vi.stubGlobal('HTMLMediaElement', { prototype: {} });
    const html = render();
    expect(testIds(html)).not.toContain('speaker-select');
    expect(html).toContain('Your browser chooses the output device.');
  });

  it('has no alert of its own until the page gives it one, then exactly one', () => {
    expect(render()).not.toContain('role="alert"');
    const html = render({}, { part: 'video', message: 'Camera is unavailable or blocked' });
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    // Shown in the part it belongs to, after the quality select.
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf('camera-quality-select'));
  });

  it('renders in Turkish', () => {
    setLocale('tr');
    const html = render({ inputMode: 'ptt' });
    expect(testIdText(html, 'settings-voice-heading')).toBe('Ses ve video');
    expect(html).toContain('>Bas-konuş<');
    expect(testIdText(html, 'ptt-key')).toBe('Bas-konuş tuşu: `');
  });
});
