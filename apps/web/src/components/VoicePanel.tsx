import { useQuery } from '@tanstack/react-query';
import { bootstrapQuery } from '../api/chat';
import { useT, type MessageKey } from '../i18n';
import { useVoice } from '../voice/context';
import { useId, type ReactNode } from 'react';
import { useVoiceSession, type PublishState, type VoiceConnectionState } from '../voice/session';

const STATUS: Record<
  Exclude<VoiceConnectionState, 'disconnected'>,
  { label: MessageKey; tone: string; dot: string }
> = {
  connecting: {
    label: 'voice.panel.connecting',
    tone: 'text-accent',
    dot: 'bg-accent motion-safe:animate-skeleton',
  },
  connected: { label: 'voice.panel.connected', tone: 'text-success', dot: 'bg-success' },
  reconnecting: {
    label: 'voice.panel.reconnecting',
    tone: 'text-accent',
    dot: 'bg-accent motion-safe:animate-skeleton',
  },
};

/** Icon-over-label control; every state keeps a visible text label (it is also the accessible name). */
const panelButton =
  'inline-flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-control px-1 py-1.5 ' +
  'text-2xs font-semibold ring-1 transition disabled:cursor-not-allowed disabled:opacity-50';

const idle = 'text-text ring-line bg-white/5 hover:bg-white/10';

/** Camera and screen share buttons: highlighted in accent (not red) while on. */
function videoClass(on: boolean): string {
  return `${panelButton} ${on ? 'bg-accent/15 text-accent ring-accent/40 hover:bg-accent/20' : idle}`;
}

/** Mute and deafen: red while on, so a muted mic is obvious at a glance. */
function toggleClass(pressed: boolean): string {
  return `${panelButton} ${pressed ? 'bg-danger/15 text-danger ring-danger/40 hover:bg-danger/20' : idle}`;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const SLASH = <path d="m2.5 2.5 11 11" strokeWidth="1.6" />;

function MicIcon({ off }: { off: boolean }) {
  return (
    <Icon>
      <path d="M6 3.5a2 2 0 0 1 4 0V8a2 2 0 0 1-4 0z" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2" />
      {off && SLASH}
    </Icon>
  );
}

function HeadphonesIcon({ off }: { off: boolean }) {
  return (
    <Icon>
      <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2M2.5 10h2v3.5h-2zM11.5 10h2v3.5h-2z" />
      {off && SLASH}
    </Icon>
  );
}

function LeaveIcon() {
  return (
    <Icon>
      <path d="M2 9.2c3.6-3 8.4-3 12 0l-1.3 1.9-2.4-.9V8.6a7 7 0 0 0-4.6 0v1.6l-2.4.9z" />
    </Icon>
  );
}

function CameraIcon({ on }: { on: boolean }) {
  return (
    <Icon>
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" />
      <path d="m10.5 7 4-2.5v7l-4-2.5" />
      {on ? null : SLASH}
    </Icon>
  );
}

function ScreenIcon() {
  return (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </Icon>
  );
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
  const t = useT();
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
  const channelName =
    boot?.channels.find((c) => c.id === channelId)?.name ?? t('voice.panel.fallbackChannel');
  const status = STATUS[state];
  const live = state === 'connected' || state === 'reconnecting';
  // Starting needs a connected room; stopping works while reconnecting too.
  const canToggle = (s: PublishState) => (s === 'off' ? state === 'connected' : s === 'on' && live);

  return (
    <section
      data-testid="voice-panel"
      data-state={state}
      aria-label={t('voice.panel.label')}
      className="flex shrink-0 flex-col gap-2 border-t border-line bg-bg/40 px-3 pt-2.5 pb-3"
    >
      <div className="flex min-w-0 items-center gap-2" role="status">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${status.dot}`} />
        <div className="min-w-0">
          <p className={`text-xs font-semibold ${status.tone}`}>{t(status.label)}</p>
          <p className="truncate text-sm text-text" title={channelName}>
            {channelName}
          </p>
        </div>
      </div>
      {live && !canPlaybackAudio && (
        <button
          type="button"
          data-testid="audio-unblock"
          className="rounded-control bg-accent px-2 py-1.5 text-xs font-semibold text-bg transition hover:brightness-110"
          onClick={startAudio}
        >
          {t('voice.enableAudio')}
        </button>
      )}
      <div className="flex gap-1.5">
        <button type="button" aria-pressed={micMuted} className={toggleClass(micMuted)} onClick={toggleMute}>
          <MicIcon off={micMuted} />
          {t(micMuted ? 'voice.unmute' : 'voice.mute')}
        </button>
        <button
          type="button"
          aria-pressed={deafened}
          className={toggleClass(deafened)}
          onClick={toggleDeafen}
        >
          <HeadphonesIcon off={deafened} />
          {t(deafened ? 'voice.undeafen' : 'voice.deafen')}
        </button>
        <button
          type="button"
          className={`${panelButton} bg-danger/10 text-danger ring-danger/40 hover:bg-danger/20 focus-visible:outline-danger`}
          onClick={leave}
        >
          <LeaveIcon />
          {t('voice.leave')}
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
          <CameraIcon on={camera === 'on'} />
          {t(camera === 'on' ? 'voice.stopCamera' : 'voice.camera')}
        </button>
        <button
          type="button"
          aria-pressed={screen === 'on'}
          disabled={!canToggle(screen)}
          className={videoClass(screen === 'on')}
          onClick={toggleScreen}
        >
          <ScreenIcon />
          {t(screen === 'on' ? 'voice.stopSharing' : 'voice.shareScreen')}
        </button>
      </div>
      <div className="flex items-center gap-2 px-0.5 text-xs text-muted">
        <input
          id={tabAudioId}
          type="checkbox"
          checked={shareTabAudio}
          disabled={screen !== 'off'}
          className="size-3.5 accent-accent disabled:cursor-not-allowed"
          onChange={(e) => {
            useVoiceSession.getState().set({ shareTabAudio: e.currentTarget.checked });
          }}
        />
        <label htmlFor={tabAudioId} className={screen !== 'off' ? 'opacity-70' : undefined}>
          {t('voice.shareTabAudio')}
        </label>
      </div>
    </section>
  );
}
