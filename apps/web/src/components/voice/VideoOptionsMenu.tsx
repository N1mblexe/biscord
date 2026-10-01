import type { CameraQuality } from '@hearth/shared';
import { useT } from '../../i18n';
import { useMediaDevices } from '../../voice/devices';
import { CAMERA_QUALITY, useVoicePrefs } from '../../voice/prefs';
import { deviceChoices, labelsHiddenFor, type RadioChoice } from './menuModel';
import {
  MenuAccessItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSettingsLink,
  OptionsMenu,
  useRecoverMenuFocus,
} from './OptionsMenu';

const QUALITIES = Object.keys(CAMERA_QUALITY) as CameraQuality[];
const QUALITY_CHOICES: readonly RadioChoice[] = QUALITIES.map((q) => ({ value: q, label: q }));

function isQuality(value: string): value is CameraQuality {
  return (QUALITIES as string[]).includes(value);
}

/**
 * **Video options** (`video-options`) next to Camera: **Camera** (`menu-camera`) and **Video
 * quality** (`menu-quality`: 360p, 720p, 1080p) radio groups, **Allow access** while camera names are
 * hidden, and **Voice & video settings**. A choice updates the prefs; a running camera follows live.
 */
export function VideoOptionsMenu({
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
      testId="video-options"
      label={t('voice.options.video')}
      open={open}
      onOpenChange={onOpenChange}
      triggerClassName={triggerClassName}
    >
      <VideoItems />
    </OptionsMenu>
  );
}

function VideoItems() {
  const t = useT();
  const devices = useMediaDevices();
  const prefs = useVoicePrefs((s) => s.prefs);
  const update = useVoicePrefs((s) => s.update);
  const hidden = labelsHiddenFor(devices, ['videoinput']);
  useRecoverMenuFocus(hidden);

  return (
    <>
      <MenuRadioGroup
        testId="menu-camera"
        label={t('voice.options.camera')}
        choices={deviceChoices(devices.videoinput, prefs.videoInputId, {
          default: t('voice.options.default'),
          saved: t('voice.options.savedDevice'),
          missing: t('voice.options.missingDevice'),
          numbered: (n) => t('voice.options.cameraN', { n }),
        })}
        checked={prefs.videoInputId}
        onChoose={(videoInputId) => {
          update({ videoInputId });
        }}
      />
      {hidden && <MenuAccessItem onRequest={() => devices.requestAccess({ video: true })} />}
      <MenuRadioGroup
        testId="menu-quality"
        label={t('voice.options.quality')}
        choices={QUALITY_CHOICES}
        checked={prefs.cameraQuality}
        onChoose={(value) => {
          if (isQuality(value)) update({ cameraQuality: value });
        }}
      />
      <MenuSeparator />
      <MenuSettingsLink />
    </>
  );
}
