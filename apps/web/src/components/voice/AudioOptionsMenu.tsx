import { useT } from '../../i18n';
import { canSelectOutput, useMediaDevices } from '../../voice/devices';
import { useVoicePrefs } from '../../voice/prefs';
import { deviceChoices, labelsHiddenFor } from './menuModel';
import {
  MenuAccessItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSettingsLink,
  OptionsMenu,
  useRecoverMenuFocus,
} from './OptionsMenu';

/**
 * **Audio options** (`audio-options`) next to Mute: **Input device** (`menu-mic`) and **Output
 * device** (`menu-speaker`, only where the browser can route output) radio groups, **Allow access**
 * while device names are hidden, and **Voice & video settings**. A choice updates the prefs; the
 * voice engine switches devices live.
 */
export function AudioOptionsMenu({
  open,
  onOpenChange,
  triggerClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName: string;
}) {
  const t = useT();
  return (
    <OptionsMenu
      testId="audio-options"
      label={t('voice.options.audio')}
      open={open}
      onOpenChange={onOpenChange}
      triggerClassName={triggerClassName}
    >
      <AudioItems />
    </OptionsMenu>
  );
}

function AudioItems() {
  const t = useT();
  const devices = useMediaDevices();
  const prefs = useVoicePrefs((s) => s.prefs);
  const update = useVoicePrefs((s) => s.update);
  const showOutput = canSelectOutput();
  const hidden = labelsHiddenFor(devices, showOutput ? ['audioinput', 'audiooutput'] : ['audioinput']);
  useRecoverMenuFocus(hidden);

  const common = {
    default: t('voice.options.default'),
    saved: t('voice.options.savedDevice'),
    missing: t('voice.options.missingDevice'),
  };

  return (
    <>
      <MenuRadioGroup
        testId="menu-mic"
        label={t('voice.options.inputDevice')}
        choices={deviceChoices(devices.audioinput, prefs.audioInputId, {
          ...common,
          numbered: (n) => t('voice.options.microphoneN', { n }),
        })}
        checked={prefs.audioInputId}
        onChoose={(audioInputId) => {
          update({ audioInputId });
        }}
      />
      {showOutput && (
        <MenuRadioGroup
          testId="menu-speaker"
          label={t('voice.options.outputDevice')}
          choices={deviceChoices(devices.audiooutput, prefs.audioOutputId, {
            ...common,
            numbered: (n) => t('voice.options.speakerN', { n }),
          })}
          checked={prefs.audioOutputId}
          onChoose={(audioOutputId) => {
            update({ audioOutputId });
          }}
        />
      )}
      {hidden && <MenuAccessItem onRequest={() => devices.requestAccess({ audio: true })} />}
      <MenuSeparator />
      <MenuSettingsLink />
    </>
  );
}
