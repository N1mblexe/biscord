import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/types';
import type { DeviceKind, DeviceOption } from '../../voice/devices';
import { inputClass } from '../styles';
import { deviceChoices } from '../voice/menuModel';

/** An unnamed device's numbered fallback, the same words as the voice panel's menus. */
const NUMBERED: Record<DeviceKind, MessageKey> = {
  audioinput: 'voice.options.microphoneN',
  audiooutput: 'voice.options.speakerN',
  videoinput: 'voice.options.cameraN',
};

/**
 * A labelled device `<select>`: **Default** first, then the devices (unnamed ones as "Microphone 2"
 * and so on), and the saved device while it isn't listed (the options of the voice panel's menus,
 * components/voice/menuModel.ts).
 */
export function DeviceSelect({
  id,
  testId,
  label,
  kind,
  devices,
  value,
  onChange,
}: {
  id: string;
  testId: string;
  label: string;
  kind: DeviceKind;
  devices: readonly DeviceOption[];
  value: string;
  onChange: (deviceId: string) => void;
}) {
  const t = useT();
  const options = deviceChoices(devices, value, {
    default: t('voice.options.default'),
    numbered: (n) => t(NUMBERED[kind], { n }),
    saved: t('voice.options.savedDevice'),
    missing: t('voice.options.missingDevice'),
  });
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <select
        id={id}
        data-testid={testId}
        className={`${inputClass} truncate`}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
