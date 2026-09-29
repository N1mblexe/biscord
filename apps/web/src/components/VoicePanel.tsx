import { useQuery } from '@tanstack/react-query';
import { bootstrapQuery } from '../api/chat';
import { useVoice } from '../voice/context';
import { useId } from 'react';
import { useVoiceSession, type PublishState, type VoiceConnectionState } from '../voice/session';

const STATUS: Record<Exclude<VoiceConnectionState, 'disconnected'>, { label: string; tone: string }> = {
  connecting: { label: 'Connecting…', tone: 'text-accent' },
  connected: { label: 'Voice connected', tone: 'text-success' },
  reconnecting: { label: 'Reconnecting…', tone: 'text-accent' },
};

const panelButton =
  'inline-flex flex-1 items-center justify-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ' +
  'transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Camera and screen share buttons: highlighted (not red) while on. */
function videoClass(on: boolean): string {
  return `${panelButton} disabled:cursor-not-allowed disabled:opacity-50 ${
    on
      ? 'bg-accent/15 text-accent ring-accent/40 hover:bg-accent/25'
      : 'text-text ring-white/10 hover:bg-white/10'
  }`;
}

function toggleClass(pressed: boolean): string {
  return `${panelButton} ${
    pressed
      ? 'bg-danger/15 text-danger ring-danger/40 hover:bg-danger/25'
      : 'text-text ring-white/10 hover:bg-white/10'
  }`;
}

/**
 * The voice panel (`data-testid="voice-panel"`, docs/plans/phase-6.md "Web UI contract"): shown
 * while in voice, with `data-state` connecting / connected / reconnecting, the channel name,
 * **Mute** or **Unmute** and **Deafen** or **Undeafen** (`aria-pressed`) and **Leave**. When the browser
 * blocks audio playback it also offers **Click to enable audio** (`data-testid="audio-unblock"`).
 * Phase 7 adds **Camera** / **Stop camera**, **Share screen** / **Stop sharing** (`aria-pressed`, disabled
 * while the browser asks or LiveKit (un)publishes) and the **Share tab audio** checkbox.
 */
export function VoicePanel() {
  const state = useVoiceSession((s) => s.state);
  const channelId = useVoiceSession((s) => s.channelId);
  const micMuted = useVoiceSession((s) => s.micMuted);
  const deafened = useVoiceSession((s) => s.deafened);
  const canPlaybackAudio = useVoiceSession((s) => s.canPlaybackAudio);
  const { data: boot } = useQuery(bootstrapQuery);
  const camera = useVoiceSession((s) => s.camera);
  const screen = useVoiceSession((s) => s.screen);
  const shareTabAudio = useVoiceSession((s) => s.shareTabAudio);
  const { toggleMute, toggleDeafen, leave, startAudio, toggleCamera, toggleScreen } = useVoice();
  const tabAudioId = useId();

  if (state === 'disconnected' || channelId === null) return null;
  const channelName = boot?.channels.find((c) => c.id === channelId)?.name ?? 'Voice channel';
  const status = STATUS[state];
  const live = state === 'connected' || state === 'reconnecting';
  // Starting needs a connected room; stopping works while reconnecting too.
  const canToggle = (s: PublishState) => (s === 'off' ? state === 'connected' : s === 'on' && live);

  return (
    <section
      data-testid="voice-panel"
      data-state={state}
      aria-label="Voice connection"
      className="flex shrink-0 flex-col gap-2 border-t border-white/5 bg-surface-raised/60 px-3 py-2.5"
    >
      <div className="min-w-0" role="status">
        <p className={`text-xs font-semibold ${status.tone}`}>{status.label}</p>
        <p className="truncate text-sm text-text" title={channelName}>
          {channelName}
        </p>
      </div>
      {live && !canPlaybackAudio && (
        <button
          type="button"
          data-testid="audio-unblock"
          className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-bg transition hover:brightness-110"
          onClick={startAudio}
        >
          Click to enable audio
        </button>
      )}
      <div className="flex gap-1.5">
        <button type="button" aria-pressed={micMuted} className={toggleClass(micMuted)} onClick={toggleMute}>
          {micMuted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          aria-pressed={deafened}
          className={toggleClass(deafened)}
          onClick={toggleDeafen}
        >
          {deafened ? 'Undeafen' : 'Deafen'}
        </button>
        <button
          type="button"
          className={`${panelButton} text-danger ring-danger/40 hover:bg-danger/10`}
          onClick={leave}
        >
          Leave
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          aria-pressed={camera === 'on'}
          disabled={!canToggle(camera)}
          className={videoClass(camera === 'on')}
          onClick={toggleCamera}
        >
          {camera === 'on' ? 'Stop camera' : 'Camera'}
        </button>
        <button
          type="button"
          aria-pressed={screen === 'on'}
          disabled={!canToggle(screen)}
          className={videoClass(screen === 'on')}
          onClick={toggleScreen}
        >
          {screen === 'on' ? 'Stop sharing' : 'Share screen'}
        </button>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <input
          id={tabAudioId}
          type="checkbox"
          checked={shareTabAudio}
          disabled={screen !== 'off'}
          className="accent-accent"
          onChange={(e) => {
            useVoiceSession.getState().set({ shareTabAudio: e.currentTarget.checked });
          }}
        />
        <label htmlFor={tabAudioId}>Share tab audio</label>
      </div>
    </section>
  );
}
