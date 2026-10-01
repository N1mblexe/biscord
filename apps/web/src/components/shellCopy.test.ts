import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tFor } from '../i18n/translate';
import type { MessageKey } from '../i18n/types';
import { PresenceDot } from './PresenceDot';

const BUTTONS: readonly MessageKey[] = [
  'voice.mute',
  'voice.unmute',
  'voice.deafen',
  'voice.undeafen',
  'voice.leave',
  'voice.camera',
  'voice.stopCamera',
  'voice.shareScreen',
  'voice.stopSharing',
  'voice.shareTabAudio',
];

describe('voice panel buttons', () => {
  it('keep the exact English names the e2e suite matches', () => {
    expect(BUTTONS.map((key) => tFor('en', key))).toEqual([
      'Mute',
      'Unmute',
      'Deafen',
      'Undeafen',
      'Leave',
      'Camera',
      'Stop camera',
      'Share screen',
      'Stop sharing',
      'Share tab audio',
    ]);
  });

  it('use the glossary in Turkish', () => {
    expect(BUTTONS.map((key) => tFor('tr', key))).toEqual([
      'Sessize al',
      'Sesi aç',
      'Sağırlaştır',
      'Sağırlığı kaldır',
      'Ayrıl',
      'Kamera',
      'Kamerayı kapat',
      'Ekranı paylaş',
      'Paylaşımı durdur',
      'Sekme sesini paylaş',
    ]);
  });
});

describe('shell copy', () => {
  it('fills names into the voice labels', () => {
    expect(tFor('en', 'voice.participant.volumeFor', { name: 'Alice' })).toBe('Volume for Alice');
    expect(tFor('tr', 'voice.participant.volumeFor', { name: 'Alice' })).toBe('Alice için ses düzeyi');
    expect(tFor('en', 'voice.stage.screenTile', { name: 'Alice' })).toBe('Alice (screen)');
    expect(tFor('tr', 'voice.stage.focus', { label: 'Alice' })).toBe('Odakla: Alice');
    expect(tFor('tr', 'voice.participant.volumePercent', { percent: 50 })).toBe('%50');
  });

  it('pluralizes the mention badge title', () => {
    expect(tFor('en', 'a11y.layout.mentions', { count: 1 })).toBe('1 mention');
    expect(tFor('en', 'a11y.layout.mentions', { count: 3 })).toBe('3 mentions');
    expect(tFor('tr', 'a11y.layout.mentions', { count: 3 })).toBe('3 bahsetme');
  });

  it('keeps the health text e2e matches, and translates it', () => {
    expect(tFor('en', 'a11y.server.ok')).toBe('Server: ok');
    expect(tFor('tr', 'a11y.server.ok')).toBe('Sunucu: çalışıyor');
  });

  it('names the presence dot', () => {
    const html = renderToStaticMarkup(createElement(PresenceDot, { online: true }));
    expect(html).toContain('aria-label="Online"');
    expect(tFor('tr', 'a11y.offline')).toBe('Çevrimdışı');
  });
});
