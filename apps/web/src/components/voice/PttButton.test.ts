import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VoiceContext, type VoiceActions } from '../../voice/context';
import { PttButton } from './PttButton';

const noop = () => undefined;
const actions: VoiceActions = {
  join: noop,
  leave: noop,
  toggleMute: noop,
  toggleDeafen: noop,
  toggleCamera: noop,
  toggleScreen: noop,
  setUserVolume: noop,
  startAudio: noop,
  pttPress: noop,
  pttRelease: noop,
};

function render(): string {
  return renderToStaticMarkup(createElement(VoiceContext, { value: actions }, createElement(PttButton)));
}

// Server rendering reads the stores' initial state: push-to-talk released, the default binding.
describe('PttButton', () => {
  it('is a hold button with no touch panning, named Push to talk, with the key hint', () => {
    const html = render();
    expect(html).toContain('data-testid="ptt-button"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('touch-action:none');
    expect(html).toContain('Push to talk</button>');
    expect(html).toContain('data-testid="ptt-hint"');
    expect(html).toContain('Hold ` to talk');
  });
});
