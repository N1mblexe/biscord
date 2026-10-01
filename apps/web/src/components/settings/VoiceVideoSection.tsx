import { CameraQuality } from '@hearth/shared';
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import {
  assignBinding,
  RECORDER_IDLE,
  recorderReducer,
  type RecorderState,
  type RecorderTarget,
} from '../../lib/voiceSettings';
import { canPromptOutput, canSelectOutput, useMediaDevices } from '../../voice/devices';
import { CAMERA_QUALITY, useVoicePrefs, type VoicePrefs } from '../../voice/prefs';
import { bindingLabel, recordBinding } from '../../voice/ptt';
import { FormAlert } from '../forms';
import { card, inputClass, secondaryButton } from '../styles';
import { CameraPreview } from './CameraPreview';
import { DeviceSelect } from './DeviceSelect';
import { KeybindRecorder, useKeyboardLayout } from './KeybindRecorder';
import { MicTest } from './MicTest';
import { SpeakerTest } from './SpeakerTest';

/** Where in the section an error happened: the page's single alert is shown there. */
export type VoiceAlertPart = 'devices' | 'test' | 'video';

/** Firefox's output picker (not in the DOM typings yet). */
type MediaDevicesWithOutputPrompt = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

const QUALITIES = Object.keys(CAMERA_QUALITY) as CameraQuality[];

/**
 * **Voice & video** (CONTRACTS B.12, docs/plans/devices.md "UI contract"): devices, the mic and
 * speaker tests, input mode (voice activity or push to talk), shortcuts, audio processing, and the
 * camera preview and quality. Everything is saved per browser through `useVoicePrefs`; a call in
 * progress picks the changes up live (voice/deviceSync.ts). No mic or camera opens without a click.
 */
export function VoiceVideoSection({
  alert,
  alertPart,
  onStart,
  onError,
}: {
  /** The page's single alert, when it belongs to this section. */
  alert: string | null;
  alertPart: VoiceAlertPart | null;
  /** The user started something here: the page clears its previous alert and results. */
  onStart: () => void;
  onError: (part: VoiceAlertPart, message: string) => void;
}) {
  const t = useT();
  const prefs = useVoicePrefs((s) => s.prefs);
  const update = useVoicePrefs((s) => s.update);
  const devices = useMediaDevices();
  const { refresh, requestAccess } = devices;
  const layout = useKeyboardLayout();
  const [recorder, dispatch] = useReducer(recorderReducer, RECORDER_IDLE);
  const [asking, setAsking] = useState(false);
  const outputSelectable = canSelectOutput();
  const outputPrompt = canPromptOutput();

  // One binding is recorded at a time; switching targets or cancelling aborts the previous wait.
  useEffect(() => {
    const target = recorder.recording;
    if (target === null) return;
    const controller = new AbortController();
    void recordBinding(window, controller.signal).then((binding) => {
      if (controller.signal.aborted) return;
      if (binding === null) {
        dispatch({ type: 'finish', target, outcome: 'cancelled' });
        return;
      }
      const result = assignBinding(useVoicePrefs.getState().prefs, target, binding);
      if ('conflict' in result) {
        dispatch({ type: 'finish', target, outcome: 'conflict' });
        return;
      }
      useVoicePrefs.getState().update(result.patch);
      dispatch({ type: 'finish', target, outcome: 'set' });
    });
    return () => {
      controller.abort();
    };
  }, [recorder.recording]);

  const allowAccess = async () => {
    onStart();
    setAsking(true);
    // Both at once is one prompt; without a camera (or a mic) that fails, so then each alone.
    const granted =
      (await requestAccess({ audio: true, video: true })) ||
      (await requestAccess({ audio: true })) ||
      (await requestAccess({ video: true }));
    setAsking(false);
    if (!granted) onError('devices', t('settings.voice.accessDenied'));
  };

  const chooseOutput = async () => {
    onStart();
    const md = navigator.mediaDevices as MediaDevicesWithOutputPrompt;
    if (md.selectAudioOutput === undefined) return;
    try {
      const device = await md.selectAudioOutput();
      update({ audioOutputId: device.deviceId });
      refresh();
    } catch {
      // Dismissed: nothing changes.
    }
  };

  const recorderProps = (target: RecorderTarget) => ({
    recording: recorder.recording === target,
    onStart: () => {
      onStart();
      dispatch({ type: 'start', target });
    },
    onCancel: () => {
      dispatch({ type: 'cancel' });
    },
  });

  const sectionAlert = (part: VoiceAlertPart) => <FormAlert message={alertPart === part ? alert : null} />;

  return (
    <section id="voice" aria-labelledby="settings-voice-heading" className={`${card} scroll-mt-4 max-md:p-4`}>
      <h2
        id="settings-voice-heading"
        data-testid="settings-voice-heading"
        tabIndex={-1}
        className="text-lg font-semibold focus:outline-none"
      >
        {t('settings.voice.heading')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('settings.voice.description')}</p>

      <div className="mt-4 flex max-w-xl flex-col gap-6">
        <Group id="settings-voice-devices" heading={t('settings.voice.devices')}>
          {!devices.supported && <p className="text-sm text-muted">{t('settings.voice.unsupported')}</p>}
          {devices.labelsHidden && (
            <div className="flex flex-col items-start gap-2">
              <p id="settings-device-access-hint" className="text-sm text-muted">
                {t('settings.voice.accessHint')}
              </p>
              <button
                type="button"
                data-testid="device-access"
                aria-describedby="settings-device-access-hint"
                className={secondaryButton}
                disabled={asking}
                onClick={() => {
                  void allowAccess();
                }}
              >
                {t('voice.options.allowAccess')}
              </button>
            </div>
          )}
          <DeviceSelect
            id="settings-mic"
            testId="mic-select"
            label={t('voice.options.inputDevice')}
            kind="audioinput"
            devices={devices.audioinput}
            value={prefs.audioInputId}
            onChange={(audioInputId) => {
              update({ audioInputId });
            }}
          />
          {outputSelectable ? (
            <DeviceSelect
              id="settings-speaker"
              testId="speaker-select"
              label={t('voice.options.outputDevice')}
              kind="audiooutput"
              devices={devices.audiooutput}
              value={prefs.audioOutputId}
              onChange={(audioOutputId) => {
                update({ audioOutputId });
              }}
            />
          ) : (
            <p className="text-sm text-muted">{t('settings.voice.outputUnsupported')}</p>
          )}
          {outputSelectable && outputPrompt && (
            <div>
              <button
                type="button"
                data-testid="speaker-choose"
                className={secondaryButton}
                onClick={() => {
                  void chooseOutput();
                }}
              >
                {t('settings.voice.chooseOutput')}
              </button>
            </div>
          )}
          <DeviceSelect
            id="settings-camera"
            testId="camera-select"
            label={t('voice.options.camera')}
            kind="videoinput"
            devices={devices.videoinput}
            value={prefs.videoInputId}
            onChange={(videoInputId) => {
              update({ videoInputId });
            }}
          />
          {sectionAlert('devices')}
        </Group>

        <Group id="settings-voice-test" heading={t('settings.voice.test')}>
          <MicTest
            prefs={prefs}
            onStart={onStart}
            onError={(message) => {
              onError('test', message);
            }}
            onCaptured={refresh}
          />
          <SpeakerTest
            outputId={prefs.audioOutputId}
            onStart={onStart}
            onError={(message) => {
              onError('test', message);
            }}
          />
          {sectionAlert('test')}
        </Group>

        <InputModeGroup
          prefs={prefs}
          update={update}
          pttLabel={t('settings.voice.pttKey', { key: bindingLabel(prefs.pttKey, layout) })}
          pttRecorder={recorderProps('pttKey')}
        />

        <Group id="settings-voice-shortcuts" heading={t('settings.voice.shortcuts')}>
          <KeybindRecorder
            testId="mute-key"
            label={t('settings.voice.muteShortcut', { key: bindingLabel(prefs.muteKey, layout) })}
            {...recorderProps('muteKey')}
            clear={{
              label: t('settings.voice.clearMute'),
              disabled: prefs.muteKey === null,
              onClear: () => {
                update({ muteKey: null });
              },
            }}
          />
          <KeybindRecorder
            testId="deafen-key"
            label={t('settings.voice.deafenShortcut', { key: bindingLabel(prefs.deafenKey, layout) })}
            {...recorderProps('deafenKey')}
            clear={{
              label: t('settings.voice.clearDeafen'),
              disabled: prefs.deafenKey === null,
              onClear: () => {
                update({ deafenKey: null });
              },
            }}
          />
          <RecorderStatus recorder={recorder} prefs={prefs} layout={layout} />
        </Group>

        <Group id="settings-voice-processing" heading={t('settings.voice.processing')}>
          <Checkbox
            id="settings-noise-suppression"
            testId="ns-toggle"
            label={t('settings.voice.noiseSuppression')}
            checked={prefs.noiseSuppression}
            onChange={(noiseSuppression) => {
              update({ noiseSuppression });
            }}
          />
          <Checkbox
            id="settings-echo-cancellation"
            testId="ec-toggle"
            label={t('settings.voice.echoCancellation')}
            checked={prefs.echoCancellation}
            onChange={(echoCancellation) => {
              update({ echoCancellation });
            }}
          />
          <Checkbox
            id="settings-auto-gain"
            testId="agc-toggle"
            label={t('settings.voice.autoGainControl')}
            checked={prefs.autoGainControl}
            onChange={(autoGainControl) => {
              update({ autoGainControl });
            }}
          />
          <p className="text-xs text-muted">{t('settings.voice.processingHint')}</p>
        </Group>

        <Group id="settings-voice-video" heading={t('settings.voice.video')}>
          <CameraPreview
            prefs={prefs}
            onStart={onStart}
            onError={(message) => {
              onError('video', message);
            }}
            onCaptured={refresh}
          />
          <div className="flex max-w-xs flex-col gap-1.5">
            <label htmlFor="settings-camera-quality" className="text-sm font-medium text-text">
              {t('voice.options.quality')}
            </label>
            <select
              id="settings-camera-quality"
              data-testid="camera-quality-select"
              className={inputClass}
              value={prefs.cameraQuality}
              onChange={(event) => {
                const parsed = CameraQuality.safeParse(event.target.value);
                if (parsed.success) update({ cameraQuality: parsed.data });
              }}
            >
              {QUALITIES.map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
          </div>
          {sectionAlert('video')}
        </Group>
      </div>
    </section>
  );
}

/** A titled part of the section. */
function Group({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-4">
      <h3 id={id} className="text-sm font-semibold tracking-wide text-muted uppercase">
        {heading}
      </h3>
      {children}
    </div>
  );
}

/**
 * **Input mode**: a radio group (fieldset/legend), then the mode's own controls. Voice activity:
 * the gate checkbox and, while it is on, the sensitivity. Push to talk: the key, the release delay
 * and the focus hint.
 */
function InputModeGroup({
  prefs,
  update,
  pttLabel,
  pttRecorder,
}: {
  prefs: VoicePrefs;
  update: (patch: Partial<VoicePrefs>) => void;
  pttLabel: string;
  pttRecorder: { recording: boolean; onStart: () => void; onCancel: () => void };
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <fieldset
        data-testid="input-mode"
        role="radiogroup"
        aria-labelledby="settings-input-mode-legend"
        className="flex flex-col gap-2"
      >
        <legend
          id="settings-input-mode-legend"
          className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase"
        >
          {t('settings.voice.inputMode')}
        </legend>
        <Radio
          id="settings-input-mode-voice"
          checked={prefs.inputMode === 'voice'}
          label={t('settings.voice.voiceActivity')}
          onSelect={() => {
            update({ inputMode: 'voice' });
          }}
        />
        <Radio
          id="settings-input-mode-ptt"
          checked={prefs.inputMode === 'ptt'}
          label={t('settings.voice.pushToTalk')}
          onSelect={() => {
            update({ inputMode: 'ptt' });
          }}
        />
      </fieldset>

      {prefs.inputMode === 'voice' ? (
        <>
          <Checkbox
            id="settings-vad-gate"
            testId="vad-gate"
            label={t('settings.voice.vadGate')}
            checked={prefs.vadGate}
            onChange={(vadGate) => {
              update({ vadGate });
            }}
          />
          {prefs.vadGate && (
            <Range
              id="settings-vad-threshold"
              testId="vad-threshold"
              label={t('settings.voice.sensitivity')}
              min={-100}
              max={0}
              step={1}
              value={prefs.vadThresholdDb}
              valueText={t('settings.voice.decibels', { value: prefs.vadThresholdDb })}
              onChange={(vadThresholdDb) => {
                update({ vadThresholdDb });
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <KeybindRecorder
              testId="ptt-key"
              label={pttLabel}
              describedBy="settings-ptt-hint"
              {...pttRecorder}
            />
            <p id="settings-ptt-hint" className="text-xs text-muted">
              {t('settings.voice.pttFocused')}
            </p>
          </div>
          <Range
            id="settings-ptt-release"
            testId="ptt-release"
            label={t('settings.voice.releaseDelay')}
            min={0}
            max={1000}
            step={10}
            value={prefs.pttReleaseMs}
            valueText={t('settings.voice.milliseconds', { value: prefs.pttReleaseMs })}
            onChange={(pttReleaseMs) => {
              update({ pttReleaseMs });
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * The recorders' polite announcements: "Press a key… (Esc to cancel)" while recording, then how it
 * ended. Visible only for a conflict (the button already shows the rest).
 */
function RecorderStatus({
  recorder,
  prefs,
  layout,
}: {
  recorder: RecorderState;
  prefs: VoicePrefs;
  layout: ReadonlyMap<string, string> | undefined;
}) {
  const t = useT();
  const { recording, last } = recorder;
  const conflict = recording === null && last?.outcome === 'conflict';
  let text = '';
  if (recording !== null) text = t('settings.voice.recording');
  else if (last?.outcome === 'set') {
    text = t('settings.voice.keySet', { key: bindingLabel(prefs[last.target], layout) });
  } else if (last?.outcome === 'cancelled') text = t('settings.voice.keyCancelled');
  else if (conflict) text = t('settings.voice.keyConflict');
  return (
    <p role="status" data-testid="keybind-status" className={conflict ? 'text-sm text-danger' : 'sr-only'}>
      {text}
    </p>
  );
}

function Checkbox({
  id,
  testId,
  label,
  checked,
  onChange,
}: {
  id: string;
  testId: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        data-testid={testId}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-accent"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
    </div>
  );
}

function Radio({
  id,
  checked,
  label,
  onSelect,
}: {
  id: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        data-testid={id.replace('settings-', '')}
        type="radio"
        name="settings-input-mode"
        className="size-4 shrink-0 accent-accent"
        checked={checked}
        onChange={(event) => {
          if (event.target.checked) onSelect();
        }}
      />
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
    </div>
  );
}

/** A labelled range with its value read out next to the label (and as `aria-valuetext`). */
function Range({
  id,
  testId,
  label,
  min,
  max,
  step,
  value,
  valueText,
  onChange,
}: {
  id: string;
  testId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <output htmlFor={id} className="shrink-0 text-xs text-muted tabular-nums">
          {valueText}
        </output>
      </div>
      <input
        id={id}
        data-testid={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        className="w-full accent-accent"
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
}
