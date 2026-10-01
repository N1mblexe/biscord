import type { DeviceKind, DeviceLists, DeviceOption } from '../../voice/devices';

/**
 * Pure logic behind the voice panel's quick menus (docs/plans/devices.md, "Voice panel"): the radio
 * choices built from the device lists plus the saved preference, and the menu's keyboard handling.
 */

export interface RadioChoice {
  value: string;
  label: string;
}

export interface DeviceChoiceLabels {
  /** The system default (`'default'`), always first. */
  default: string;
  /** A device without a label (the browser hides names until access is allowed); `n` counts from 1. */
  numbered: (n: number) => string;
  /** The saved device while nothing is listed yet (no permission or no API). */
  saved: string;
  /** The saved device is not in a non-empty list (unplugged). */
  missing: string;
}

/**
 * The radio choices for one device kind: **Default** first, then each listed device (Chromium's own
 * `'default'` pseudo-device is folded into **Default**), then the saved device when it isn't listed,
 * so the checked choice always exists. Unlabelled devices are numbered in list order.
 */
export function deviceChoices(
  list: readonly DeviceOption[],
  selectedId: string,
  labels: DeviceChoiceLabels,
): RadioChoice[] {
  const choices: RadioChoice[] = [{ value: 'default', label: labels.default }];
  let n = 0;
  for (const device of list) {
    if (device.deviceId === 'default') continue;
    n += 1;
    choices.push({ value: device.deviceId, label: device.label === '' ? labels.numbered(n) : device.label });
  }
  if (!choices.some((c) => c.value === selectedId)) {
    choices.push({ value: selectedId, label: list.length === 0 ? labels.saved : labels.missing });
  }
  return choices;
}

/**
 * Whether the names of `kinds` are hidden (no permission yet), so the menu offers **Allow access**.
 * `labelsHidden` covers every kind at once; a kind whose devices all have names (its permission was
 * granted) doesn't count. An empty list does, since browsers list nothing without permission.
 */
export function labelsHiddenFor(lists: DeviceLists, kinds: readonly DeviceKind[]): boolean {
  if (!lists.supported || !lists.labelsHidden) return false;
  return kinds.some((kind) => {
    const list = lists[kind];
    return list.length === 0 || list.some((d) => d.label === '');
  });
}

export type MenuKeyResult =
  /** Focus item `index`. */
  | { type: 'focus'; index: number }
  /** Activate the focused item (check a radio, follow the link). */
  | { type: 'activate' }
  /** Close the menu and give focus back to its button. */
  | { type: 'close' };

/**
 * A key press inside an open menu of `count` items whose item `index` has focus (-1: none): arrows
 * move (wrapping), Home/End jump, Enter/Space activate, Escape and Tab close. `null` means the key
 * isn't the menu's (let the browser handle it).
 */
export function menuKey(key: string, index: number, count: number): MenuKeyResult | null {
  switch (key) {
    case 'Escape':
    case 'Tab':
      return { type: 'close' };
    case 'Enter':
    case ' ':
      return index < 0 ? null : { type: 'activate' };
  }
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return { type: 'focus', index: index < 0 ? 0 : (index + 1) % count };
    case 'ArrowUp':
      return { type: 'focus', index: index < 0 ? count - 1 : (index - 1 + count) % count };
    case 'Home':
      return { type: 'focus', index: 0 };
    case 'End':
      return { type: 'focus', index: count - 1 };
    default:
      return null;
  }
}
